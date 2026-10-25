"""事件觀測資料歸檔(手動執行):把一段期間的原始觀測另存一份,不受 cleanup 保留策略影響
(測站、雷達、雨量只留 KEEP_DAYS 天、衛星只留 SAT_KEEP_DAYS 天,超過全刪)→ 事件結束後要在期限內執行。
  python -m pipeline.event_archive --name 薔琵颱風 --start "2026-10-22 00:00" --end "2026-10-24 20:00" [--web] [--satellite]
時間為台灣時間。存到 archive/{起}_{迄}_{名稱}/,目錄結構同 data/(每層一個 index.json,只含期間內的時間):
  預設(觀測):stations(測站 10 分鐘快照)、radar(雷達整合回波)、rain/cwa/1h、rain/cwa/today(氣象署雨量格點)、
             typhoon/cwa_track、typhoon/cwa(颱風消息;颱風往前多存一天,路徑才接得起來)
  --web:另存網頁圖層用的衍生資料 stations/agg_*、rain/idw/*(要在網頁重播事件時才需要)
  --satellite:另存衛星雲圖 B03 / B07 / B08 / B13(只保留 SAT_KEEP_DAYS 天,事件結束後要盡快執行;檔案大)
本機 data/ 有的直接複製,沒有的從 R2 公開網址下載;已存在的檔跳過(中斷後重跑會接著做)。
格點(.bin.gz)與 agg(.json.gz)原本就是壓縮檔照原樣存;沒壓縮的 .json(測站快照、颱風路徑)存成 .json.gz。
.env 有 R2 金鑰時,另外上傳到 R2 的 events/{起}_{迄}_{名稱}/(--no-upload 不上傳),並更新 events/index.json。
event_stats / radar_video / event_report 讀資料時會自動找 archive/,所以原始資料被清掉後還是能重做統計和影片。"""
import argparse
import gzip
import json
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

from . import config

ARCHIVE_DIR = config.ROOT / "archive"
R2_URL = "https://pub-95cef959cf924e2e938a1d1b2a833e45.r2.dev/"
H = {"User-Agent": "Mozilla/5.0"}
OBS = {"stations": ".json", "radar": ".bin.gz", "rain/cwa/1h": ".bin.gz", "rain/cwa/today": ".bin.gz",
       "typhoon/cwa_track": ".json", "typhoon/cwa": ".json.gz"}
WEB = {**{f"stations/agg_{h}": ".json.gz" for h in ("1h", "2h", "3h", "6h", "12h", "24h", "48h", "72h")},
       **{f"rain/idw/{h}": ".bin.gz" for h in ("10m", "1h", "3h", "6h", "12h", "24h", "48h", "72h", "today")}}
SAT = {f"satellite/{b}": ".bin.gz" for b in ("B03", "B07", "B08", "B13")}
EARLY = {"typhoon/cwa_track": 1, "typhoon/cwa": 1}          # 往前多存幾天


# ── 給 event_stats / radar_video 讀歸檔用 ──
def _indexes(layer):
    for d in sorted(ARCHIVE_DIR.glob("*/")):
        p = d / layer / "index.json"
        if p.exists():
            yield d, json.loads(p.read_text(encoding="utf-8"))


def times(layer):
    """所有歸檔裡這一層的時間。"""
    return {t for _, idx in _indexes(layer) for t in idx.get("times", [])}


def meta(layer):
    """第一個有這一層的歸檔 index(例如雷達的 grid);沒有回傳 {}。"""
    return next((idx for _, idx in _indexes(layer)), {})


def find(layer, name):
    """歸檔裡的 {layer}/{name}(.json 也找壓縮過的 .json.gz);沒有回傳 None。讀 JSON 用 load_json。"""
    if not ARCHIVE_DIR.exists():
        return None
    names = [name, name + ".gz"] if name.endswith(".json") else [name]
    for d in sorted(ARCHIVE_DIR.glob("*/")):
        for n in names:
            p = d / layer / n
            if p.exists():
                return p
    return None


def load_json(path):
    """讀 JSON(.json.gz 先解壓)。"""
    data = path.read_bytes()
    return json.loads(gzip.decompress(data) if path.name.endswith(".gz") else data)


# ── 歸檔 ──
def to_stamp(text):
    tw = datetime.strptime(text, "%Y-%m-%d %H:%M").replace(tzinfo=timezone(timedelta(hours=8)))
    return tw.astimezone(timezone.utc).strftime("%Y%m%d%H%M")


def tw_fmt(stamp, fmt):
    dt = datetime.strptime(stamp, "%Y%m%d%H%M").replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone(timedelta(hours=8))).strftime(fmt)


def source_index(layer, use_r2):
    """本機 index ∪ R2 index(R2 沒有這層就只用本機);回傳 (times, 其他欄位)。"""
    p = config.DATA_DIR / layer / "index.json"
    idx = json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}
    ts = set(idx.get("times", []))
    if use_r2:
        r = requests.get(f"{R2_URL}{layer}/index.json", headers=H, timeout=60)
        if r.status_code == 200:
            remote = r.json()
            ts |= set(remote.get("times", []))
            for k, v in remote.items():
                idx.setdefault(k, v)
    return sorted(ts), {k: v for k, v in idx.items() if k not in ("times", "fetched")}


def fetch(layer, name, dest, use_r2):
    """本機 data/ → 複製;否則從 R2 下載。沒壓縮的 .json 存成 .json.gz(測站快照約剩 1/4)。回傳 True = 有檔。"""
    gz = name.endswith(".json")
    if gz:
        dest = dest.with_name(dest.name + ".gz")
    if dest.exists():
        return True
    src = config.DATA_DIR / layer / name
    if src.exists():
        data = src.read_bytes()
    elif use_r2:
        r = requests.get(f"{R2_URL}{layer}/{name}", headers=H, timeout=120)
        if r.status_code != 200:
            return False
        data = r.content
    else:
        return False
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".tmp")
    tmp.write_bytes(gzip.compress(data, 6) if gz else data)
    tmp.replace(dest)
    return True


def archive_layer(out, layer, ext, start, end, use_r2):
    ts, rest = source_index(layer, use_r2)
    lo = (datetime.strptime(start, "%Y%m%d%H%M") - timedelta(days=EARLY.get(layer, 0))).strftime("%Y%m%d%H%M")
    sel = [t for t in ts if lo <= t <= end]
    if not sel:
        return 0, 0
    with ThreadPoolExecutor(8) as ex:
        ok = list(ex.map(lambda t: fetch(layer, f"{t}{ext}", out / layer / f"{t}{ext}", use_r2), sel))
    saved = [t for t, k in zip(sel, ok) if k]
    (out / layer).mkdir(parents=True, exist_ok=True)
    (out / layer / "index.json").write_text(json.dumps({**rest, "times": saved}, ensure_ascii=False,
                                                       separators=(",", ":")), encoding="utf-8")
    size = sum(f.stat().st_size for f in (out / layer).iterdir())
    return len(saved), size


def upload(out):
    """上傳到 R2 events/{資料夾}/(已存在且大小相同的跳過),再更新 events/index.json。"""
    from . import r2
    if not r2.enabled():
        print("R2 未設定(.env 沒有 R2_*),只存本機。到排程電腦再執行一次同樣的指令即可上傳。")
        return
    prefix = f"events/{out.name}/"
    remote = {}
    for page in r2.client().get_paginator("list_objects_v2").paginate(Bucket=r2.bucket(), Prefix=prefix):
        for o in page.get("Contents", []):
            remote[o["Key"]] = o["Size"]
    files = [f for f in out.rglob("*") if f.is_file() and not f.name.endswith(".tmp")]
    todo = [f for f in files if remote.get(prefix + f.relative_to(out).as_posix()) != f.stat().st_size]

    def put(f):
        key = prefix + f.relative_to(out).as_posix()
        ctype = "application/json; charset=utf-8" if f.suffix == ".json" else "application/octet-stream"
        r2.client().put_object(Bucket=r2.bucket(), Key=key, Body=f.read_bytes(), ContentType=ctype)

    with ThreadPoolExecutor(8) as ex:
        list(ex.map(put, todo))
    try:
        body = r2.client().get_object(Bucket=r2.bucket(), Key="events/index.json")["Body"].read()
        events = json.loads(body)
    except Exception:
        events = []
    info = json.loads((out / "event.json").read_text(encoding="utf-8"))
    events = [e for e in events if e.get("dir") != out.name] + [{**info, "dir": out.name}]
    events.sort(key=lambda e: e["start_utc"])
    r2.client().put_object(Bucket=r2.bucket(), Key="events/index.json", CacheControl="no-cache",
                           Body=json.dumps(events, ensure_ascii=False, indent=1).encode("utf-8"),
                           ContentType="application/json; charset=utf-8")
    print(f"R2:上傳 {len(todo)} 個檔(共 {len(files)} 個)→ {prefix}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--name", required=True, help="事件名稱(資料夾用),例如 薔琵颱風、1025豪雨")
    ap.add_argument("--start", required=True, help='台灣時間,例如 "2026-10-22 00:00"')
    ap.add_argument("--end", required=True, help="台灣時間")
    ap.add_argument("--web", action="store_true", help="另存網頁圖層衍生資料(stations/agg_*、rain/idw/*)")
    ap.add_argument("--satellite", action="store_true", help="另存衛星雲圖(只保留 SAT_KEEP_DAYS 天)")
    ap.add_argument("--no-upload", action="store_true", help="有 R2 金鑰也不上傳")
    ap.add_argument("--local", action="store_true", help="只用本機 data/,不從 R2 下載")
    a = ap.parse_args()
    start, end = to_stamp(a.start), to_stamp(a.end)
    out = ARCHIVE_DIR / f"{tw_fmt(start, '%Y%m%d%H%M')}_{tw_fmt(end, '%Y%m%d%H%M')}_{a.name}"
    layers = {**OBS, **(WEB if a.web else {}), **(SAT if a.satellite else {})}
    print(f"歸檔 {a.name}:{a.start} – {a.end}(台灣)→ {out}")
    counts, total = {}, 0
    for layer, ext in layers.items():
        n, size = archive_layer(out, layer, ext, start, end, not a.local)
        counts[layer] = n
        total += size
        print(f"  {layer:<20} {n:>5} 筆 {size / 1e6:8.1f} MB")
    out.mkdir(parents=True, exist_ok=True)
    info = {"name": a.name, "start": a.start, "end": a.end, "start_utc": start, "end_utc": end,
            "archived": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "layers": counts}
    (out / "event.json").write_text(json.dumps(info, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"本機共 {total / 1e6:.1f} MB")
    if not a.no_upload:
        upload(out)


if __name__ == "__main__":
    main()

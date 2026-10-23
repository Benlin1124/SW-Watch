"""測站時間序列:一站一個資料夾、一個月一個 CSV。
  data/stations/series/stations.csv          測站基本資料
  data/stations/series/{站號}/{YYYYMM}.csv   每 10 分鐘一列(time = 快照時間,UTC)
從快照(data/stations/{stamp}.json)寫入,所以也能用 --rebuild 從所有快照重建。"""
import argparse
import csv
import gzip
import json
import shutil
from datetime import datetime, timezone

from . import config
from .common import log

SERIES_DIR = config.DATA_DIR / "stations" / "series"
LAST_PATH = SERIES_DIR / "_last.json"          # 各站最後寫入時間,避免每次去讀 1000 多個檔尾
INFO_FIELDS = ["id", "name", "lon", "lat", "alt", "county", "town", "type"]
SKIP = set(INFO_FIELDS) | {"gust_t"}           # 其餘欄位都進 CSV;obs 改名 wx_obs(氣象要素的觀測時間)
# gust_t 只給 station_agg 用;CSV 欄位在月初建檔時就固定,中途加欄會錯位


def _fmt(v):
    return "" if v is None else (f"{v:g}" if isinstance(v, float) else str(v))


def _load_last():
    return json.loads(LAST_PATH.read_text(encoding="utf-8")) if LAST_PATH.exists() else {}


def _update_info(fields, rows):
    """stations.csv:新站加入、既有站資料以最新為準。"""
    path = SERIES_DIR / "stations.csv"
    info = {}
    if path.exists():
        with open(path, encoding="utf-8-sig", newline="") as f:
            info = {r["id"]: r for r in csv.DictReader(f)}
    for row in rows:
        rec = dict(zip(fields, row))
        info[rec["id"]] = {k: _fmt(rec.get(k)) for k in INFO_FIELDS}
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8-sig", newline="") as f:   # utf-8-sig:Excel 開中文不亂碼
        w = csv.DictWriter(f, INFO_FIELDS)
        w.writeheader()
        w.writerows(sorted(info.values(), key=lambda r: r["id"]))


def append(snapshot, last=None, save_last=True):
    """把一個快照({time, fields, rows})寫進各站 CSV;同一站同一時間不重複寫。"""
    stamp, fields, rows = snapshot["time"], snapshot["fields"], snapshot["rows"]
    cols = [f for f in fields if f not in SKIP]
    header = ["time"] + ["wx_obs" if c == "obs" else c for c in cols]
    last = _load_last() if last is None else last
    month = stamp[:6]
    n = 0
    for row in rows:
        rec = dict(zip(fields, row))
        sid = rec["id"]
        if last.get(sid, "") >= stamp:
            continue
        path = SERIES_DIR / sid / f"{month}.csv"
        new = not path.exists()
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "a", encoding="utf-8", newline="") as f:
            w = csv.writer(f)
            if new:
                w.writerow(header)
            w.writerow([stamp] + [_fmt(rec[c]) for c in cols])
        last[sid] = stamp
        n += 1
    _update_info(fields, rows)
    if save_last:
        LAST_PATH.write_text(json.dumps(last), encoding="utf-8")
    log.info("station series %s:寫入 %d 站", stamp, n)
    return last


def compress_old_months():
    """當月以前的 CSV 壓成 .csv.gz(由每日 cleanup 呼叫)。"""
    this_month = datetime.now(timezone.utc).strftime("%Y%m")
    for p in SERIES_DIR.glob("*/*.csv"):
        if p.stem < this_month:
            with open(p, "rb") as src, gzip.open(p.with_suffix(".csv.gz"), "wb") as dst:
                shutil.copyfileobj(src, dst)
            p.unlink()


def rebuild():
    """清空 series 後,依時間順序把所有快照重新寫入。"""
    if SERIES_DIR.exists():
        shutil.rmtree(SERIES_DIR)
    last = {}
    snaps = sorted((config.DATA_DIR / "stations").glob("[0-9]*.json"))
    for i, p in enumerate(snaps):
        last = append(json.loads(p.read_text(encoding="utf-8")), last,
                      save_last=(i == len(snaps) - 1))
    compress_old_months()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--rebuild", action="store_true", help="從所有快照重建 series")
    if ap.parse_args().rebuild:
        import logging
        logging.basicConfig(level=logging.INFO)
        rebuild()

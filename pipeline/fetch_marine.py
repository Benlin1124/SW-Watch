"""海象:O-B0075-001(48 小時浮標站與潮位站海況監測資料,每小時一筆;只有 REST datastore)
+ O-B0076-001(海象測站基本資料:站名、座標、站種;fileapi,每天更新)
→ data/marine/{stamp}.json   每小時一個快照,格式同 stations(fields + rows,站名座標一起存)
→ data/marine/recent.json.gz 近 KEEP_DAYS 天各站時序(資訊卡折線圖用,壓縮後約 150 KB)
平常只抓最近 FETCH_HOURS 小時(timeFrom,約幾十 KB);本機沒資料或斷了比較久才抓整份 48 小時(約 1.8 MB)補齊。
晚到的資料會補進已存在的整點(內容有變才重寫)。"""
import gzip
import json
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from . import config
from .common import (check_update, fetch_cwa, fetch_cwa_rest, layer_dir, log, read_index, save_json, save_points,
                     stamp_dt, utc_stamp)

LAYER = "marine"
CODE = "O-B0075-001"
CODE_30D = "O-B0075-002"                 # 30 天資料(修復用;約 26 MB,大約晚一天)
META_CODE = "O-B0076-001"
FETCH_HOURS = 4            # 平常抓最近幾小時
RECENT_HOURS = 24 * config.KEEP_DAYS   # 資訊卡可選到 10 天(同快照保留天數)
TW = timezone(timedelta(hours=8))

# 站種:潮位站 / 資料浮標 / 岸邊氣象站 / 浮球式波浪站
TYPES = {"潮位站": "tide", "浮標站": "buoy", "氣象站": "coast", "浮球站": "wave"}
META_FIELDS = ["id", "name", "lon", "lat", "type", "county", "area"]
VALUE_FIELDS = ["tide", "tide_lv",                # 潮高(m)、漲退潮
                "wave_h", "wave_dir", "wave_per",  # 浪高(m)、波向(°,浪來的方向)、週期(s)
                "sst", "temp", "pres",             # 海溫、氣溫(°C)、氣壓(hPa)
                "ws", "wd", "gust",                # 風速、風向(°,風來的方向)、最大陣風(m/s)
                "cur_spd", "cur_dir"]              # 海流第 1 層流速(m/s)、流向(°,流去的方向)
FIELDS = META_FIELDS + VALUE_FIELDS


def _num(v):
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return None if x <= -90 else x


def station_meta():
    """站號 → 基本資料(fileapi + S3 條件式請求,沒更新不耗流量)。"""
    locs = fetch_cwa(META_CODE)["Resources"]["Resource"]["Data"]["SeaSurfaceObs"]["Location"]
    out = {}
    for loc in locs:
        s = loc["Station"]
        try:
            lon, lat = float(s["StationLongitude"]), float(s["StationLatitude"])
        except (TypeError, ValueError):
            continue
        out[s["StationID"]] = {"id": s["StationID"], "name": s["StationName"], "lon": round(lon, 5),
                               "lat": round(lat, 5), "type": TYPES.get(s.get("StationAttribute"), "tide"),
                               "county": (s.get("County") or {}).get("CountyName"),
                               "area": (s.get("Area") or {}).get("AreaName")}
    return out


def values(w):
    a = w.get("PrimaryAnemometer") or {}
    layers = (w.get("SeaCurrents") or {}).get("Layer") or []
    cur = next((x for x in layers if str(x.get("LayerNumber")) == "1"), layers[0] if layers else {})
    lv = w.get("TideLevel")
    return {"tide": _num(w.get("TideHeight")), "tide_lv": lv if lv not in (None, "", "-", "None") else None,
            "wave_h": _num(w.get("WaveHeight")), "wave_dir": _num(w.get("WaveDirection")),
            "wave_per": _num(w.get("WavePeriod")), "sst": _num(w.get("SeaTemperature")),
            "temp": _num(w.get("Temperature")), "pres": _num(w.get("StationPressure")),
            "ws": _num(a.get("WindSpeed")), "wd": _num(a.get("WindDirection")), "gust": _num(a.get("MaximumWindSpeed")),
            "cur_spd": _num(cur.get("CurrentSpeed")), "cur_dir": _num(cur.get("CurrentDirection"))}


def collect(time_from=None, code=CODE):
    """→ {stamp: {站號: 數值 dict}};time_from = 台灣時間 datetime(None = 整份 48 小時)。"""
    params = {"timeFrom": time_from.strftime("%Y-%m-%dT%H:%M:%S")} if time_from else {}
    data = fetch_cwa_rest(code, timeout=300, **params)
    out = defaultdict(dict)
    for loc in data["Records"]["SeaSurfaceObs"]["Location"]:
        sid = loc["Station"]["StationID"]
        for o in (loc.get("StationObsTimes") or {}).get("StationObsTime") or []:
            v = values(o.get("WeatherElements") or {})
            if any(x is not None for k, x in v.items() if k != "tide_lv"):
                out[utc_stamp(o["DateTime"])][sid] = v
    return out


def _read(stamp):
    p = layer_dir(LAYER) / f"{stamp}.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


def write_recent(meta, latest):
    """近 RECENT_HOURS 小時各站時序(從本機快照組):{time, start, step, n, fields, stations: {站號: {欄位: [值…]}}}。"""
    end = stamp_dt(latest)
    stamps = [(end - timedelta(hours=h)).strftime("%Y%m%d%H%M") for h in range(RECENT_HOURS, -1, -1)]
    st = {}
    for i, t in enumerate(stamps):
        snap = _read(t)
        if not snap:
            continue
        f = {k: j for j, k in enumerate(snap["fields"])}
        for r in snap["rows"]:
            s = st.setdefault(r[f["id"]], {k: [None] * len(stamps) for k in VALUE_FIELDS})
            for k in VALUE_FIELDS:
                if k in f:
                    s[k][i] = r[f[k]]
    for s in st.values():                       # 整段都沒有的欄位不存
        for k in [k for k, v in s.items() if all(x is None for x in v)]:
            del s[k]
    save_json(layer_dir(LAYER) / "recent.json.gz",
              {"time": latest, "start": stamps[0], "step": 60, "n": len(stamps), "fields": VALUE_FIELDS,
               "meta": {k: meta[k] for k in st if k in meta}, "stations": st}, gz=True)


def merge_write(meta, obs, source):
    """把各整點的觀測併進既有快照:有回傳的站更新、沒回傳的站保留原本的值(不會因為某次只回傳部分站就把其他站蓋掉)。
    內容有變才重寫(省 R2 上傳)。回傳寫入的整點。"""
    written = []
    for stamp in sorted(obs):
        old = _read(stamp)
        rows = {}
        if old:
            fo = {k: i for i, k in enumerate(old["fields"])}
            for r in old["rows"]:
                rows[r[fo["id"]]] = [r[fo[k]] if k in fo else None for k in FIELDS]
        for sid, v in obs[stamp].items():
            if sid in meta:
                rows[sid] = [meta[sid].get(k) for k in META_FIELDS] + [v.get(k) for k in VALUE_FIELDS]
        new = [rows[sid] for sid in sorted(rows)]
        if old and old.get("fields") == FIELDS and old.get("rows") == new:
            continue
        save_points(LAYER, stamp, {"time": stamp, "fields": FIELDS, "rows": new}, fields=FIELDS, source=source)
        written.append(stamp)
    return written


def run():
    meta = station_meta()
    prev = read_index(LAYER).get("latest")
    full = not prev or datetime.now(timezone.utc) - stamp_dt(prev) > timedelta(hours=FETCH_HOURS - 1)
    since = None if full else (stamp_dt(prev) - timedelta(hours=FETCH_HOURS - 1)).astimezone(TW)
    obs = collect(since)
    if not obs:
        raise RuntimeError(f"{CODE} 沒有資料")
    latest = max(obs)
    status, prev = check_update(LAYER, latest, ".json")
    if status == "older":
        return status, latest, prev

    written = merge_write(meta, obs, f"CWA {CODE} / {META_CODE}")
    if written:
        write_recent(meta, max(read_index(LAYER)["times"]))
        log.info("marine %s 完成(寫入 %d 個整點%s)", latest, len(written), ",完整 48 小時" if full else "")
    unknown = {sid for v in obs.values() for sid in v} - set(meta)
    if unknown:
        log.debug("marine 沒有基本資料的站(略過):%s", "、".join(sorted(unknown)))
    return status, latest, prev


def repair(days=config.KEEP_DAYS):
    """補回 / 修復最近 days 天的快照:30 天資料(O-B0075-002,約 26 MB,大約晚一天)+ 48 小時資料,合併寫入。
    2026-10-26:一次抓取只回傳花蓮資料浮標,當時的寫法整個覆蓋 → 43 個整點只剩 1 站,用這個補回。"""
    meta = station_meta()
    cut = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y%m%d%H%M")
    obs = defaultdict(dict)
    for code in (CODE_30D, CODE):                           # 48 小時的較新,後併
        for stamp, v in collect(code=code).items():
            if stamp >= cut:
                obs[stamp].update(v)
    written = merge_write(meta, obs, f"CWA {CODE_30D} / {CODE} / {META_CODE}")
    if written:
        write_recent(meta, max(read_index(LAYER)["times"]))
    log.info("marine 修復:%d 個整點有資料,寫入 %d 個(%s – %s)", len(obs), len(written),
             min(obs, default="-"), max(obs, default="-"))
    return written


if __name__ == "__main__":
    import argparse
    import logging
    logging.basicConfig(level=logging.INFO)
    ap = argparse.ArgumentParser()
    ap.add_argument("--repair", action="store_true", help="用 30 天 + 48 小時資料補回 / 修復最近 KEEP_DAYS 天的快照")
    ap.add_argument("--days", type=int, default=config.KEEP_DAYS)
    a = ap.parse_args()
    if a.repair:
        from . import r2
        repair(a.days)
        print("R2 上傳 / 刪除:", r2.flush())               # 單獨執行沒有排程幫忙 flush
    else:
        print(run())
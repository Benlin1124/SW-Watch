"""各縣市測站近 72 小時時序(網頁點測站看折線圖用)
  data/stations/recent/{縣市名 UTF-8 hex}.json.gz
    {county, time, hours,
     t10: {start, step: 10, n}   10 分鐘格(雨量;第 i 格 = start + 10i 分,最後一格 = time)
     th:  {start, step: 60, n}   整點格(氣象要素,依各站觀測時間 obs 放)
     have: "1101…"               每個 10 分鐘格有沒有快照(缺漏要看得到,不補)
     stations: {站號: {name, town, type, alt, lon, lat,
                       rain_10m: [n10], rain_1h: [n10], temp/rh/pres/ws/wd/gust/gust_dir: [nh]}}}
每 10 分鐘:讀回各縣市檔 → 時間窗往後移 → 填入新快照 → 寫回(22 個檔,R2 每月約 9.5 萬次寫入)。
不放每站一個檔:1362 站 × 每 10 分鐘 = 每月約 590 萬次寫入,超過 R2 免費額度。
重建:python -m pipeline.station_recent --rebuild"""
import argparse
import gzip
import json
from datetime import timedelta

from . import r2
from .common import layer_dir, log, read_index, save_json, stamp_dt

LAYER = "stations/recent"
HOURS = 72
RAIN = ["rain_10m", "rain_1h"]
WX = ["temp", "rh", "pres", "ws", "wd", "gust", "gust_dir"]
INFO = ["name", "town", "type", "alt", "lon", "lat"]


def county_key(county):
    """檔名用縣市名的 UTF-8 hex(純 ASCII,前端用 TextEncoder 算得出來)。"""
    return (county or "其他").encode("utf-8").hex()


def _fmt(dt):
    return dt.strftime("%Y%m%d%H%M")


def window(stamp):
    """(10 分鐘格起點, 整點格起點):各涵蓋 (T-72h, T]。"""
    t = stamp_dt(stamp)
    t10 = t - timedelta(minutes=10 * (HOURS * 6 - 1))
    th = t.replace(minute=0) - timedelta(hours=HOURS - 1)
    return _fmt(t10), _fmt(th)


def _offset(old_start, new_start, step):
    return round((stamp_dt(new_start) - stamp_dt(old_start)).total_seconds() / 60 / step)


def _shift(arr, k, n):
    """陣列往前移 k 格、長度補到 n(新格為 None)。"""
    arr = arr[k:] if k >= 0 else [None] * (-k) + arr
    return (arr + [None] * n)[:n]


def empty(county, stamp):
    s10, sh = window(stamp)
    n10, nh = HOURS * 6, HOURS
    return {"county": county, "time": stamp, "hours": HOURS,
            "t10": {"start": s10, "step": 10, "n": n10}, "th": {"start": sh, "step": 60, "n": nh},
            "have": "0" * n10, "stations": {}}


def rewindow(state, stamp):
    """把既有狀態的時間窗移到以 stamp 結尾。"""
    if state["time"] == stamp:
        return state
    s10, sh = window(stamp)
    k10 = _offset(state["t10"]["start"], s10, 10)
    kh = _offset(state["th"]["start"], sh, 60)
    n10, nh = state["t10"]["n"], state["th"]["n"]
    have = list(state["have"])
    have = (have[k10:] if k10 >= 0 else ["0"] * (-k10) + have) + ["0"] * n10
    state["have"] = "".join(have[:n10])
    for st in state["stations"].values():
        for v in RAIN:
            st[v] = _shift(st[v], k10, n10)
        for v in WX:
            st[v] = _shift(st[v], kh, nh)
    state["t10"]["start"], state["th"]["start"], state["time"] = s10, sh, stamp
    return state


def apply(states, snap, stamp):
    """把一個快照填進各縣市狀態(狀態的時間窗結尾 = stamp)。"""
    f = {k: i for i, k in enumerate(snap["fields"])}
    t = snap["time"]
    s10, sh = window(stamp)
    i10 = _offset(s10, t, 10)
    if not 0 <= i10 < HOURS * 6:
        return
    for row in snap["rows"]:
        county = row[f["county"]] or "其他"
        state = states.get(county)
        if state is None:
            state = states[county] = empty(county, stamp)
        sid = row[f["id"]]
        st = state["stations"].get(sid)
        if st is None:
            st = state["stations"][sid] = {**{k: None for k in INFO},
                                           **{v: [None] * (HOURS * 6) for v in RAIN},
                                           **{v: [None] * HOURS for v in WX}}
        for k in INFO:
            if k in f and row[f[k]] is not None:
                st[k] = row[f[k]]
        for v in RAIN:
            if v in f:
                st[v][i10] = row[f[v]]
        obs = row[f["obs"]] if "obs" in f else None
        if obs and obs.endswith("00"):
            ih = _offset(sh, obs, 60)
            if 0 <= ih < HOURS:
                for v in WX:
                    if v in f and row[f[v]] is not None:
                        st[v][ih] = row[f[v]]
    for state in states.values():
        h = list(state["have"])
        h[i10] = "1"
        state["have"] = "".join(h)


def _load_states():
    states = {}
    d = layer_dir(LAYER)
    for p in d.glob("*.json.gz"):
        s = json.loads(gzip.decompress(p.read_bytes()))
        states[s["county"]] = s
    return states


def _save(states):
    for county, s in states.items():
        # 整段都沒有資料的站拿掉(撤站等)
        s["stations"] = {k: v for k, v in s["stations"].items()
                         if any(x is not None for var in RAIN + WX for x in v[var])}
        save_json(layer_dir(LAYER) / f"{county_key(county)}.json.gz", s, gz=True)


def run(snapshot):
    stamp = snapshot["time"]
    states = _load_states()
    for s in states.values():
        rewindow(s, stamp)
    apply(states, snapshot, stamp)
    _save(states)
    log.info("station_recent %s 完成(%d 個縣市)", stamp, len(states))


def rebuild(stamp=None):
    """從 data/stations 快照重建最近 72 小時。"""
    times = read_index("stations")["times"]
    stamp = stamp or times[-1]
    s10, _ = window(stamp)
    states = {}
    for t in [t for t in times if s10 <= t <= stamp]:
        snap = json.loads((layer_dir("stations") / f"{t}.json").read_text(encoding="utf-8"))
        apply(states, snap, stamp)
    for s in states.values():
        s["time"] = stamp
    _save(states)
    n, _ = r2.flush()
    log.info("station_recent 重建到 %s:%d 個縣市%s", stamp, len(states), f",R2 上傳 {n}" if r2.enabled() else "")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--rebuild", action="store_true")
    if ap.parse_args().rebuild:
        import logging
        logging.basicConfig(level=logging.INFO)
        rebuild()

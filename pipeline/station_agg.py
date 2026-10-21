"""測站過去 N 小時最大 / 最小:從最近的快照(data/stations/{stamp}.json)算出
  data/stations/agg_{N}h/{stamp}.json
    {time, start, hours, vars, ids, max: [[各變數]...], min: [[...]...],
     expected, found, missing}     ← missing = 區間內缺的快照時間(缺漏要看得到,不補)
區間為 (stamp - N 小時, stamp]。
氣象要素(溫度、風…)是每小時一筆,用各站自己的觀測時間 obs 判斷是否在區間內;
雨量(10 分鐘、1 小時)每 10 分鐘一筆,用快照時間判斷。
重建全部:python -m pipeline.station_agg --rebuild"""
import argparse
import json
from datetime import timedelta

from . import config
from .common import layer_dir, log, read_index, save_points, stamp_dt

LAYER = "stations"
WINDOWS = (1, 2, 3, 6)
WX_VARS = ["temp", "rh", "pres", "ws", "gust"]
RAIN_VARS = ["rain_10m", "rain_1h"]
VARS = WX_VARS + RAIN_VARS

_cache = {}                                    # stamp → 快照;排程常駐時不用每 10 分鐘重讀 36 個檔


def _load(stamp):
    if stamp not in _cache:
        path = layer_dir(LAYER) / f"{stamp}.json"
        _cache[stamp] = json.loads(path.read_text(encoding="utf-8")) if path.exists() else None
    return _cache[stamp]


def _shift(stamp, minutes):
    return (stamp_dt(stamp) + timedelta(minutes=minutes)).strftime("%Y%m%d%H%M")


def _expected(stamp, hours):
    return [_shift(stamp, -10 * i) for i in range(hours * 6)][::-1]


def compute(stamp, hours, times):
    start = _shift(stamp, -hours * 60)
    expected = _expected(stamp, hours)
    have = set(times)
    found = [t for t in expected if t in have]
    acc = {}                                   # id → {var: [值...]}
    order = []
    for t in found:
        snap = _load(t)
        if snap is None:
            continue
        f = {k: i for i, k in enumerate(snap["fields"])}
        for row in snap["rows"]:
            sid = row[f["id"]]
            if sid not in acc:
                acc[sid] = {v: [] for v in VARS}
                order.append(sid)
            wx_ok = (row[f["obs"]] or "") > start
            for v in VARS:
                x = row[f[v]] if v in f else None
                if x is not None and (v in RAIN_VARS or wx_ok):
                    acc[sid][v].append(x)
    rnd = lambda x: round(x, 1)
    ids, mx, mn = [], [], []
    for sid in order:
        vals = acc[sid]
        if not any(vals.values()):
            continue
        ids.append(sid)
        mx.append([rnd(max(vals[v])) if vals[v] else None for v in VARS])
        mn.append([rnd(min(vals[v])) if vals[v] else None for v in VARS])
    return {"time": stamp, "start": start, "hours": hours, "vars": VARS, "ids": ids,
            "max": mx, "min": mn, "expected": len(expected), "found": len(found),
            "missing": [t for t in expected if t not in have]}


def run(stamp, times=None):
    times = times if times is not None else read_index(LAYER)["times"]
    for h in WINDOWS:
        out = compute(stamp, h, times)
        save_points(f"{LAYER}/agg_{h}h", stamp, out, vars=VARS, hours=h,
                    source="由 data/stations 快照計算", name=f"測站過去 {h} 小時最大/最小")
    oldest = _shift(stamp, -max(WINDOWS) * 60)
    for t in [t for t in _cache if t <= oldest]:
        del _cache[t]
    n = out["found"]
    log.info("station_agg %s 完成(6 小時內快照 %d/%d)", stamp, n, out["expected"])


def rebuild():
    times = read_index(LAYER)["times"]
    for t in times:
        run(t, times)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--rebuild", action="store_true")
    if ap.parse_args().rebuild:
        import logging
        logging.basicConfig(level=logging.INFO)
        rebuild()

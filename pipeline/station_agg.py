"""測站過去 N 小時最大 / 最小(N = 1、2、3、6、12、24、48、72)
  data/stations/agg_{N}h/{stamp}.json.gz(gzip 壓縮的 JSON,前端自己解)
    {time, start, hours, vars, ids, max: [[各變數]...], min: [[...]...],
     expected, found, missing}     ← missing = 區間內缺的快照時間(缺漏要看得到,不補)
區間為 (stamp - N 小時, stamp]。
  - 6 小時以內:直接從快照(data/stations/{stamp}.json)算。
    氣象要素(溫度、風…)是每小時一筆,用各站自己的觀測時間 obs 判斷是否在區間內;
    雨量(10 分鐘、1 小時)每 10 分鐘一筆,用快照時間判斷。
  - 12 小時以上:把 N 個互不重疊的 1 小時區間 (T-k-1h, T-kh] 合併,不必每 10 分鐘讀 432 個快照。
    氣象要素是整點觀測、會晚幾十分鐘才出現在快照裡,所以每一段依「觀測時間」歸屬:
    往後多看 LOOKAHEAD 分鐘的快照(不超過 T);看滿的段落結果不會再變,存在記憶體重複使用。
重建全部:python -m pipeline.station_agg --rebuild"""
import argparse
import json
from datetime import timedelta

from . import r2
from .common import layer_dir, log, read_index, remove, save_json, stamp_dt, update_index

LAYER = "stations"
WINDOWS = (1, 2, 3, 6, 12, 24, 48, 72)
SHORT_MAX = 6                                  # 6 小時以內直接從快照算
LOOKAHEAD = 90                                 # 分段時往後多看幾分鐘的快照(整點觀測的上架延遲)
WX_VARS = ["temp", "rh", "pres", "ws", "gust"]
RAIN_VARS = ["rain_10m", "rain_1h"]
VARS = WX_VARS + RAIN_VARS

_cache = {}                                    # stamp → 快照;排程常駐時不用每 10 分鐘重讀 36 個檔
_cache_1h = {}                                 # 段落結束時間 → 已看滿 LOOKAHEAD 的 1 小時結果


def _load(stamp):
    if stamp not in _cache:
        path = layer_dir(LAYER) / f"{stamp}.json"
        _cache[stamp] = json.loads(path.read_text(encoding="utf-8")) if path.exists() else None
    return _cache[stamp]


def _shift(stamp, minutes):
    return (stamp_dt(stamp) + timedelta(minutes=minutes)).strftime("%Y%m%d%H%M")


def _expected(stamp, hours):
    return [_shift(stamp, -10 * i) for i in range(hours * 6)][::-1]


def compute(stamp, hours, times, until=None):
    """從快照算 (stamp - hours, stamp] 的最大 / 最小。
    until:另外掃描到這個時間的快照,只取觀測時間落在區間內的氣象要素(分段合併用)。"""
    start = _shift(stamp, -hours * 60)
    expected = _expected(stamp, hours)
    have = set(times)
    found = [t for t in expected if t in have]
    extra = [t for t in times if stamp < t <= until] if until else []
    acc = {}                                   # id → {var: [值...]}
    order = []
    for t in found + extra:
        rain_ok = t <= stamp
        snap = _load(t)
        if snap is None:
            continue
        f = {k: i for i, k in enumerate(snap["fields"])}
        for row in snap["rows"]:
            sid = row[f["id"]]
            if sid not in acc:
                acc[sid] = {v: [] for v in VARS}
                order.append(sid)
            wx_ok = start < (row[f["obs"]] or "") <= stamp
            for v in VARS:
                x = row[f[v]] if v in f else None
                if x is not None and (rain_ok if v in RAIN_VARS else wx_ok):
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


def _one_hour(end, now, times):
    """(end - 1h, end] 的結果,掃描到 min(end + LOOKAHEAD, now) 的快照;看滿的才快取。"""
    if end in _cache_1h:
        return _cache_1h[end]
    full = _shift(end, LOOKAHEAD)
    out = compute(end, 1, times, until=min(full, now))
    if full <= now:
        _cache_1h[end] = out
        for t in [t for t in _cache if t <= _shift(end, -60)]:   # 往後的段落用不到更舊的快照
            if t < _shift(now, -SHORT_MAX * 60 - 60):
                del _cache[t]
    return out


def merge(stamp, hours, times):
    """N 個互不重疊的 1 小時結果合併成 N 小時(由舊到新算,邊算邊釋放舊快照)。"""
    parts = [_one_hour(_shift(stamp, -60 * k), stamp, times) for k in reversed(range(hours))]
    mx, mn, order = {}, {}, []
    for p in parts:
        for sid, a, b in zip(p["ids"], p["max"], p["min"]):
            if sid not in mx:
                mx[sid], mn[sid] = list(a), list(b)
                order.append(sid)
                continue
            mx[sid] = [y if x is None else x if y is None else max(x, y) for x, y in zip(mx[sid], a)]
            mn[sid] = [y if x is None else x if y is None else min(x, y) for x, y in zip(mn[sid], b)]
    return {"time": stamp, "start": _shift(stamp, -hours * 60), "hours": hours, "vars": VARS, "ids": order,
            "max": [mx[s] for s in order], "min": [mn[s] for s in order],
            "expected": sum(p["expected"] for p in parts), "found": sum(p["found"] for p in parts),
            "missing": [t for p in parts for t in p["missing"]]}


def _save(hours, stamp, out):
    layer = f"{LAYER}/agg_{hours}h"
    save_json(layer_dir(layer) / f"{stamp}.json.gz", out, gz=True)
    update_index(layer, stamp, vars=VARS, hours=hours, ext=".json.gz",
                 source="由 data/stations 快照計算", name=f"測站過去 {hours} 小時最大/最小")


def run(stamp, times=None):
    times = times if times is not None else read_index(LAYER)["times"]
    for h in WINDOWS:
        out = compute(stamp, h, times) if h <= SHORT_MAX else merge(stamp, h, times)
        _save(h, stamp, out)
    for cache, keep_min in ((_cache, SHORT_MAX * 60 + 60), (_cache_1h, max(WINDOWS) * 60 + 60)):
        oldest = _shift(stamp, -keep_min)
        for t in [t for t in cache if t <= oldest]:
            del cache[t]
    log.info("station_agg %s 完成(72 小時內快照 %d/%d)", stamp, out["found"], out["expected"])


def rebuild():
    """清掉舊檔(含舊版未壓縮的 .json)後全部重算;刪除與上傳會同步到 R2。"""
    for h in WINDOWS:
        d = layer_dir(f"{LAYER}/agg_{h}h")
        for p in list(d.glob("2*.json")) + list(d.glob("2*.json.gz")) + list(d.glob("index.json")):
            remove(p)
    _cache_1h.clear()
    times = read_index(LAYER)["times"]
    for t in times:
        run(t, times)
    n, d = r2.flush()
    if r2.enabled():
        log.info("R2:上傳 %d、刪除 %d", n, d)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--rebuild", action="store_true")
    if ap.parse_args().rebuild:
        import logging
        logging.basicConfig(level=logging.INFO)
        rebuild()

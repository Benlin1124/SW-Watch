"""測站過去 N 小時最大 / 最小(N = 1、2、3、6、12、24、48、72)
  data/stations/agg_{N}h/{stamp}.json.gz(gzip 壓縮的 JSON,前端自己解)
    {time, start, hours, vars, ids, max: [[各變數]...], min: [[...]...],
     max_t: [[各變數發生時間]...], min_t: [[...]...],
     expected, found, missing}     ← missing = 區間內缺的快照時間(缺漏要看得到,不補)
發生時間:氣象要素 = 觀測時間 obs;雨量 = 那 10 分鐘 / 1 小時的結束時間(快照時間,日本站用 obs);
陣風 = 實際發生時間(CWA GustInfo 的 gust_at、日本站 gust_t)。同值取最早的一次。
區間為 (stamp - N 小時, stamp]。
  - 6 小時以內:直接從快照(data/stations/{stamp}.json)算。
    氣象要素(溫度、風…)是整點或 10 分鐘一筆,用各站自己的觀測時間 obs 判斷是否在區間內;
    雨量(10 分鐘、1 小時)每 10 分鐘一筆,用快照時間判斷。
    日本氣象廳站的陣風另外算(day_max_gust):只有當日最大與發生時間,只算最大,最小留空。
  - 12 小時以上:把 N 個互不重疊的 1 小時區間 (T-k-1h, T-kh] 合併,不必每 10 分鐘讀 432 個快照。
    氣象要素是整點觀測、會晚幾十分鐘才出現在快照裡,所以每一段依「觀測時間」歸屬:
    往後多看 LOOKAHEAD 分鐘的快照(不超過 T);看滿的段落結果不會再變,存在記憶體重複使用。
重建全部:python -m pipeline.station_agg --rebuild"""
import argparse
import bisect
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
    acc = {}                                   # id → {var: [(值, 發生時間)...]}
    order, gust_max_only = [], set()
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
            obs = row[f["obs"]] or ""
            wx_ok = start < obs <= stamp
            jma = "type" in f and row[f["type"]] == "jma"
            day_gust = "gust_t" in f and row[f["gust_t"]]
            if day_gust:
                gust_max_only.add(sid)
            for v in VARS:
                x = row[f[v]] if v in f and not (v == "gust" and day_gust) else None
                if x is not None and (rain_ok if v in RAIN_VARS else wx_ok):
                    at = (obs if jma else t) if v in RAIN_VARS else (
                        row[f["gust_at"]] if v == "gust" and "gust_at" in f and row[f["gust_at"]] else obs)
                    acc[sid][v].append((x, at))
    rnd = lambda x: round(x, 1)
    ids, mx, mn, mxt, mnt = [], [], [], [], []
    for sid in order:
        vals = acc[sid]
        if not any(vals.values()):
            continue
        ids.append(sid)
        hi = [min(vals[v], key=lambda p: (-p[0], p[1])) if vals[v] else None for v in VARS]
        lo = [min(vals[v], key=lambda p: (p[0], p[1])) if vals[v] and not (v == "gust" and sid in gust_max_only) else None
              for v in VARS]
        mx.append([rnd(p[0]) if p else None for p in hi])
        mn.append([rnd(p[0]) if p else None for p in lo])
        mxt.append([p[1] if p else None for p in hi])
        mnt.append([p[1] if p else None for p in lo])
    return {"time": stamp, "start": start, "hours": hours, "vars": VARS, "ids": ids,
            "max": mx, "min": mn, "max_t": mxt, "min_t": mnt, "expected": len(expected), "found": len(found),
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
    acc, order = {}, []                        # id → {"max"/"min": [[值, 時間] 各變數]}
    for p in parts:
        nv = len(VARS)
        for i, sid in enumerate(p["ids"]):
            if sid not in acc:
                acc[sid] = {k: [[None, None] for _ in VARS] for k in ("max", "min")}
                order.append(sid)
            for k, better in (("max", lambda a, b: a > b), ("min", lambda a, b: a < b)):
                ts = p.get(f"{k}_t") or [[None] * nv] * len(p["ids"])
                for j, (x, at) in enumerate(zip(p[k][i], ts[i])):
                    cur = acc[sid][k][j]
                    if x is not None and (cur[0] is None or better(x, cur[0])):   # 由舊到新,同值保留較早的
                        acc[sid][k][j] = [x, at]
    pick = lambda k, n: [[c[n] for c in acc[s][k]] for s in order]
    return {"time": stamp, "start": _shift(stamp, -hours * 60), "hours": hours, "vars": VARS, "ids": order,
            "max": pick("max", 0), "min": pick("min", 0), "max_t": pick("max", 1), "min_t": pick("min", 1),
            "expected": sum(p["expected"] for p in parts), "found": sum(p["found"] for p in parts),
            "missing": [t for p in parts for t in p["missing"]]}


def day_max_gust(stamp, hours, times):
    """日本氣象廳站的過去 N 小時最大陣風 → ({站: (值, 發生時間)}, 有當日最大資料的站)。
    當日最大只增不減、日本時間 00 時(UTC 15 時)歸零:區間內每個日本日,取不晚於該日結束(或區間結尾)的
    最後一筆快照;它的當日最大發生時間落在區間內,就是那一段的最大。排程中途停過也沒關係,
    同一天之後任何一筆快照都帶得到;只有停機期間跨過日本時間 00 時,前一天的才拿不到。"""
    start = _shift(stamp, -hours * 60)
    times = sorted(times)
    ends, b = [stamp], stamp_dt(stamp).replace(hour=15, minute=0)
    if b.strftime("%Y%m%d%H%M") > stamp:
        b -= timedelta(days=1)
    while b.strftime("%Y%m%d%H%M") > start:
        ends.append(b.strftime("%Y%m%d%H%M"))
        b -= timedelta(days=1)
    best, seen = {}, set()
    for e in ends:
        i = bisect.bisect_right(times, e) - 1
        if i < 0 or times[i] <= start:
            continue
        snap = _load(times[i])
        if snap is None or "gust_t" not in snap["fields"]:
            continue
        f = {k: i for i, k in enumerate(snap["fields"])}
        for row in snap["rows"]:
            gt, v = row[f["gust_t"]], row[f["gust_day"]]
            if not gt:
                continue
            seen.add(row[f["id"]])
            sid = row[f["id"]]
            if v is not None and start < gt <= stamp and v >= best.get(sid, (v, gt))[0]:
                best[sid] = (v, gt)
    return best, seen


def _apply_day_gust(out, stamp, hours, times):
    best, seen = day_max_gust(stamp, hours, times)
    gi, idx = VARS.index("gust"), {s: i for i, s in enumerate(out["ids"])}
    for sid in seen:
        if sid not in idx:
            if sid not in best:
                continue
            idx[sid] = len(out["ids"])
            out["ids"].append(sid)
            for k in ("max", "min", "max_t", "min_t"):
                out[k].append([None] * len(VARS))
        i = idx[sid]
        out["max"][i][gi], out["max_t"][i][gi] = (round(best[sid][0], 1), best[sid][1]) if sid in best else (None, None)
        out["min"][i][gi] = out["min_t"][i][gi] = None
    return out


def _save(hours, stamp, out):
    layer = f"{LAYER}/agg_{hours}h"
    save_json(layer_dir(layer) / f"{stamp}.json.gz", out, gz=True)
    update_index(layer, stamp, vars=VARS, hours=hours, ext=".json.gz",
                 source="由 data/stations 快照計算", name=f"測站過去 {hours} 小時最大/最小")


def run(stamp, times=None):
    times = times if times is not None else read_index(LAYER)["times"]
    for h in WINDOWS:
        out = compute(stamp, h, times) if h <= SHORT_MAX else merge(stamp, h, times)
        _save(h, stamp, _apply_day_gust(out, stamp, h, times))
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

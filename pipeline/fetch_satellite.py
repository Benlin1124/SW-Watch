"""衛星雲圖:Himawari-9 全盤 HSD(AWS noaa-himawari9,免金鑰)→ 裁切 SAT_EXTENT
  data/satellite/{B13,B08,B03}/{stamp}.bin.gz(uint8;stamp = 掃描開始時間 UTC)
輸出格點在 Web Mercator 上等間距(列在麥卡托 y 等距、行在經度等距),
MapLibre image source 用四角定位就不會有緯度方向的偏移(5–35N 用經緯度等距格點會差到約 0.8°)。
只下載涵蓋範圍的分段(全盤 10 段中的第 2–5 段)。
重投影用最近鄰:目標格點 → 原始掃描行列的對照表只算一次,存在 pipeline/.cache。
B03 可見光只在範圍內有白天時處理(夜間不存檔,前端顯示無資料)。

補抓:python -m pipeline.fetch_satellite --start 202610210000 --end 202610211200 [--bands B13,B08]"""
import argparse
import gc
import hashlib
import math
import shutil
from datetime import datetime, timedelta, timezone

import numpy as np

from . import config
from .common import grid_spec, log, read_index, record_status, save_grid, stamp_dt

LAYER = "satellite"
N_SEG = 10
_fs = None
_attempted = set()           # (stamp, band):這次執行期間試過但還沒上架的,過窗口才記 missed
_given_up = set()            # 過了窗口、試過仍沒有的 (stamp, band),不再檢查
_since = None                # 補抓起點:程序啟動時 = 各頻道最後一筆(最多回溯 SAT_KEEP_DAYS),補完後跟著往前


def fs():
    global _fs
    if _fs is None:
        import s3fs
        _fs = s3fs.S3FileSystem(anon=True, use_listings_cache=False)
    return _fs


# ── 格點 ─────────────────────────────────────────────
def _merc(lat):
    return math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


def target(band):
    """回傳 (grid spec, 各行經度 1D, 各列緯度 1D);第 0 列在最南。"""
    res, _, scale, offset, units = config.SAT_BANDS[band]
    w, s, e, n = config.SAT_EXTENT
    nx = round((e - w) / res)
    ys, yn = _merc(s), _merc(n)
    ny = round((yn - ys) / math.radians(res))
    lons = w + (np.arange(nx) + 0.5) * (e - w) / nx
    lats = np.degrees(np.arctan(np.sinh(ys + (np.arange(ny) + 0.5) * (yn - ys) / ny)))
    spec = grid_spec(w + res / 2, s, res, nx, ny, np.uint8, scale=scale, offset=offset, units=units)
    spec.update(proj="merc", west=w, east=e, south=s, north=n,
                corners=[[w, n], [e, n], [e, s], [w, s]])
    for k in ("lon0", "lat0", "dy"):
        spec.pop(k)
    return spec, lons, lats


def segments():
    """涵蓋 SAT_EXTENT 的全盤分段編號(1 = 最北)。"""
    from pyproj import Proj
    p = Proj(proj="geos", h=35785863, lon_0=140.7, a=6378137, b=6356752.3, sweep="y")
    half = 2750 * 2000.4                  # 全盤 5500 列 × 2 km 的一半
    w, s, e, n = config.SAT_EXTENT
    lines = [(half - p(lon, lat)[1]) / 2000.4 for lon in (w, (w + e) / 2, e) for lat in (s, n)]
    first, last = int(min(lines) // 550) + 1, int(max(lines) // 550) + 1
    return list(range(max(first, 1), min(last, N_SEG) + 1))


def _mapping(band, area, lons, lats):
    """目標格點 → 原始資料 (列, 行);範圍外為 -1。依原始區域快取。"""
    key = hashlib.md5(f"{band}{area.area_extent}{area.shape}{config.SAT_EXTENT}{len(lons)}x{len(lats)}".encode()).hexdigest()[:12]
    path = config.CACHE_DIR / f"sat_idx_{band}_{key}.npz"
    if path.exists():
        z = np.load(path)
        return z["rows"], z["cols"]
    rows = np.full((len(lats), len(lons)), -1, np.int32)
    cols = np.full_like(rows, -1)
    step = 200                                     # 分塊算,B03 一次算會用掉好幾 GB
    for i in range(0, len(lats), step):
        LON, LAT = np.meshgrid(lons, lats[i:i + step])
        c, r = area.get_array_indices_from_lonlat(LON, LAT)     # 回傳順序是 (行, 列)
        mask = np.ma.getmaskarray(r) | np.ma.getmaskarray(c)
        rows[i:i + step] = np.where(mask, -1, np.ma.getdata(r))
        cols[i:i + step] = np.where(mask, -1, np.ma.getdata(c))
    path.parent.mkdir(parents=True, exist_ok=True)
    np.savez(path, rows=rows, cols=cols)
    log.info("satellite %s 對照表已建立(%s)", band, path.name)
    return rows, cols


# ── 白天判斷(B03 用)──────────────────────────────────
def max_sun_elevation(stamp):
    """範圍內粗網格的最大太陽仰角(度)。"""
    dt = stamp_dt(stamp)
    doy = dt.timetuple().tm_yday
    decl = math.radians(23.44) * math.sin(2 * math.pi * (284 + doy) / 365)
    w, s, e, n = config.SAT_EXTENT
    lon, lat = np.meshgrid(np.linspace(w, e, 21), np.radians(np.linspace(s, n, 11)))
    ha = np.radians((dt.hour + dt.minute / 60 + lon / 15 - 12) * 15)
    el = np.arcsin(np.sin(lat) * math.sin(decl) + np.cos(lat) * math.cos(decl) * np.cos(ha))
    return float(np.degrees(el.max()))


def is_day(stamp):
    return max_sun_elevation(stamp) > 3


# ── 抓取 ─────────────────────────────────────────────
def slot_dir(stamp):
    return f"{config.SAT_BUCKET}/{stamp[:4]}/{stamp[4:6]}/{stamp[6:8]}/{stamp[8:12]}"


def list_slot(stamp):
    """這個時次已上架的檔:band → 涵蓋範圍的分段檔(不完整就不放)。"""
    try:
        names = fs().ls(slot_dir(stamp))
    except FileNotFoundError:
        return {}
    segs = segments()
    out = {}
    for band in config.SAT_BANDS:
        files = sorted(f for f in names if f"_{band}_" in f and f.endswith(".bz2")
                       and int(f.rsplit("_S", 1)[1][:2]) in segs)
        if len(files) == len(segs):
            out[band] = files
    return out


def process(stamp, band, keys):
    from satpy import Scene
    spec, lons, lats = target(band)
    tmp = config.CACHE_DIR / "himawari" / f"{stamp}_{band}"
    tmp.mkdir(parents=True, exist_ok=True)
    local = [str(tmp / k.rsplit("/", 1)[1]) for k in keys]
    try:
        fs().get(keys, local)
        mb = sum((tmp / k.rsplit("/", 1)[1]).stat().st_size for k in keys) / 1e6
        # mask_space 會為整個分段算經緯度(B03 要好幾 GB);對照表本來就只取地球上的點,不需要
        scn = Scene(reader="ahi_hsd", filenames=local, reader_kwargs={"mask_space": False})
        cal = config.SAT_BANDS[band][1]
        scn.load([band], calibration=cal)
        da = scn[band]
        area = da.attrs["area"]
        area = area.squeeze() if hasattr(area, "squeeze") else area
        rows, cols = _mapping(band, area, lons, lats)
        ok = rows >= 0
        r0, r1, c0, c1 = rows[ok].min(), rows[ok].max(), cols[ok].min(), cols[ok].max()
        sub = da.data[r0:r1 + 1, c0:c1 + 1]
        sub = np.asarray(sub.compute() if hasattr(sub, "compute") else sub, dtype=np.float32)
        arr = np.full(rows.shape, np.nan, np.float32)
        arr[ok] = sub[rows[ok] - r0, cols[ok] - c0]
        if cal == "brightness_temperature":
            arr -= 273.15
        del scn, da, sub
        save_grid(f"{LAYER}/{band}", stamp, arr, spec, source="JMA Himawari-9 (NOAA AWS)",
                  name=f"Himawari-9 {band}", time_meaning="掃描開始時間")
        log.info("satellite %s %s 完成(下載 %.0f MB)", band, stamp, mb)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
        gc.collect()


def wanted(stamp, band, have):
    if band == "B03" and (int(stamp[10:12]) % config.SAT_B03_EVERY_MIN or not is_day(stamp)):
        return False
    return stamp not in have[band] and (stamp, band) not in _given_up


def run(now=None):
    """最近 SAT_WAIT_MIN 分鐘內的時次,還沒有的頻道上架了就處理。回傳處理的 [(stamp, band)]。
    每輪只處理一個時次就結束(B03 一筆要 1–2 分鐘),下一分鐘重新從最新的找起,
    新上架的時次才不會被舊時次卡住。順序:B13/B08 由新到舊 → 都齊了才做 B03。"""
    global _since
    now = now or datetime.now(timezone.utc)
    have = {b: set(read_index(f"{LAYER}/{b}")["times"]) for b in config.SAT_BANDS}
    t = now.replace(minute=now.minute - now.minute % 10, second=0, microsecond=0)
    wait = timedelta(minutes=config.SAT_WAIT_MIN)
    if _since is None:                                      # 重啟:從各頻道最後一筆之後補到最新
        lasts = [stamp_dt(max(v)) for v in have.values() if v]
        floor = t - timedelta(days=config.SAT_KEEP_DAYS)
        _since = max(min(lasts), floor) if lasts else t - wait
        if _since < t - wait:
            log.info("satellite 補抓 %s 之後的時次", _since.strftime("%Y%m%d%H%M"))
    slots = []                                              # 還缺頻道的時次(新的先)
    old_pending = False
    slot = t
    while slot >= _since:
        stamp = slot.strftime("%Y%m%d%H%M")
        need = [b for b in config.SAT_BANDS if wanted(stamp, b, have)]
        if need and now - slot > wait:
            for b in [b for b in need if (stamp, b) in _attempted]:   # 過了窗口、試過仍沒有 → missed,不再檢查
                record_status(f"sat_{b}", "missed", stamp, max(have[b], default=None), 0, None)
                _attempted.discard((stamp, b))
                _given_up.add((stamp, b))
            need = [b for b in need if (stamp, b) not in _given_up]
            old_pending |= bool(need)
        if need:
            slots.append((stamp, need))
        slot -= timedelta(minutes=10)
    if not old_pending:
        _since = max(_since, t - wait)                      # 補完了,之後只看窗口內

    avail_cache = {}
    for slow in (False, True):                               # 先 B13/B08,再 B03
        for stamp, need in slots:
            bands = [b for b in need if (b == "B03") == slow]
            if not bands:
                continue
            if stamp not in avail_cache:
                avail_cache[stamp] = list_slot(stamp)
            avail = avail_cache[stamp]
            done = []
            for b in bands:
                prev = max(have[b], default=None)
                if b not in avail:
                    _attempted.add((stamp, b))
                    continue
                try:
                    process(stamp, b, avail[b])
                    record_status(f"sat_{b}", "new", stamp, prev, 0, None)
                    done.append((stamp, b))
                except Exception as e:
                    log.exception("satellite %s %s 失敗", b, stamp)
                    record_status(f"sat_{b}", "error", stamp, prev, 0, f"{type(e).__name__}: {e}")
                _attempted.discard((stamp, b))
            if done:
                return done
    return []


def backfill(start, end, bands):
    t, end_dt = stamp_dt(start), stamp_dt(end)
    while t <= end_dt:
        stamp = t.strftime("%Y%m%d%H%M")
        have = {b: set(read_index(f"{LAYER}/{b}")["times"]) for b in bands}
        need = [b for b in bands if wanted(stamp, b, have)]
        if need:
            avail = list_slot(stamp)
            for b in need:
                if b in avail:
                    process(stamp, b, avail[b])
                else:
                    log.warning("satellite %s %s:AWS 上沒有完整檔案", b, stamp)
        t += timedelta(minutes=10)


def cleanup():
    """本機只留 SAT_KEEP_DAYS 天。"""
    import json
    from .common import remove, save_json
    cutoff = (datetime.now(timezone.utc) - timedelta(days=config.SAT_KEEP_DAYS)).strftime("%Y%m%d%H%M")
    for band in config.SAT_BANDS:
        d = config.DATA_DIR / LAYER / band
        idx_path = d / "index.json"
        if not idx_path.exists():
            continue
        idx = json.loads(idx_path.read_text(encoding="utf-8"))
        drop = {t for t in idx["times"] if t < cutoff}
        if not drop:
            continue
        for t in drop:
            remove(d / f"{t}.bin.gz")
        idx["times"] = [t for t in idx["times"] if t not in drop]
        idx["fetched"] = {t: v for t, v in idx.get("fetched", {}).items() if t not in drop}
        save_json(idx_path, idx)
        log.info("cleanup satellite/%s:刪除 %d 筆", band, len(drop))


if __name__ == "__main__":
    import logging
    logging.basicConfig(level=logging.INFO)
    ap = argparse.ArgumentParser()
    ap.add_argument("--start")
    ap.add_argument("--end")
    ap.add_argument("--bands", default=",".join(config.SAT_BANDS))
    a = ap.parse_args()
    if a.start:
        backfill(a.start, a.end or a.start, a.bands.split(","))
    else:
        print(run())

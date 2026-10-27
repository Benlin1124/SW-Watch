"""衛星雲圖:Himawari-9 全盤 HSD(AWS noaa-himawari9,免金鑰)→ 裁切 SAT_EXTENT
  data/satellite/{B13,B07,B08}/{stamp}.bin.gz   紅外線數值格點(uint8,0.02°,24 小時)
  data/satellite/TC/{stamp}.webp                真實色(日夜合成,0.01°,24 小時;見 truecolor.py)
  data/satellite/B03_2km/{stamp}.bin.gz         B03 可見光數值格點(0.02°,白天;和真實色一起做)
  stamp = 掃描開始時間 UTC。舊的 0.01° satellite/B03 不再產生,cleanup 照樣清到過期。
輸出格點在 Web Mercator 上等間距(列在麥卡托 y 等距、行在經度等距),
MapLibre image source 用四角定位就不會有緯度方向的偏移(5–35N 用經緯度等距格點會差到約 0.8°)。
只下載涵蓋範圍的分段(全盤 10 段中的第 2–5 段)。
重投影用最近鄰:目標格點 → 原始掃描行列的對照表只算一次,存在 pipeline/.cache。
真實色:白天時次下載 B01–B04(約 220 MB)做彩色,夜間時次只用已存的 B07 / B13 做紅外線灰階(不用下載)。

補抓:python -m pipeline.fetch_satellite --start 202610210000 --end 202610211200 [--bands B13,B07,B08,TC]
  時間是 UTC(台灣時間 − 8 小時);已有的時次跳過;要在有 R2 金鑰的排程電腦執行,排程可以同時開著。
  TC 要該時次已有 B07(夜間灰階用),所以補 TC 時把 B07、B13 一起列上。
  補抓的資料一樣只保留 SAT_KEEP_DAYS 天(預設 5)。"""
import argparse
import gc
import gzip
import hashlib
import io
import json
import math
import shutil
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

from . import config, r2
from .common import _atomic_write, grid_spec, log, read_index, record_status, save_grid, stamp_dt, update_index

LAYER = "satellite"
TC, B03 = "TC", "B03_2km"                      # 真實色、B03 0.02° 格點的資料夾
PRODUCTS = [*config.SAT_BANDS, TC]             # 排程逐一檢查的產品(B03_2km 跟著 TC 一起做)
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


def target(res, scale=1.0, offset=0.0, units=""):
    """解析度 res(°)的麥卡托等距格點 → (grid spec, 各行經度 1D, 各列緯度 1D);第 0 列在最南。"""
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


def band_target(band):
    res, _, scale, offset, units = config.SAT_BANDS[band]
    return target(res, scale, offset, units)


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


# ── 白天判斷(可見光用)──────────────────────────────────
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


def vis_wanted(stamp):
    """這個時次要做白天可見光(下載 B01–B04)。"""
    return is_day(stamp) and int(stamp[10:12]) % config.SAT_B03_EVERY_MIN == 0


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
    for band in (*config.SAT_BANDS, *config.SAT_VIS_BANDS):
        files = sorted(f for f in names if f"_{band}_" in f and f.endswith(".bz2")
                       and int(f.rsplit("_S", 1)[1][:2]) in segs)
        if len(files) == len(segs):
            out[band] = files
    return out


def load_band(stamp, band, keys, lons, lats, cal):
    """下載分段 → 校正 → 取到目標格點(最近鄰)→ float32 (ny, nx),第 0 列在南,範圍外 NaN;回傳 (陣列, 下載 MB)。"""
    import dask
    from satpy import Scene
    # satpy 依 dask 的 array.chunk-size 切塊;預設一塊約 120 MB(B03 2200×14300),只用到一角也整塊算 → 改小省記憶體
    dask.config.set({"array.chunk-size": "16MiB"})
    # 每次呼叫自己一個資料夾:同時有別的程序(另一個排程、手動補抓)做同一時次頻道,結束時的 rmtree 才不會刪到對方的檔
    root = config.CACHE_DIR / "himawari"
    root.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix=f"{stamp}_{band}_", dir=root))
    local = [str(tmp / k.rsplit("/", 1)[1]) for k in keys]
    try:
        fs().get(keys, local)
        for k, f in zip(keys, local):                     # 批次下載偶爾少一個檔卻不報錯 → 逐一補,再缺就放棄這次
            if not Path(f).exists():
                log.warning("satellite %s %s 分段沒下載到,重抓 %s", band, stamp, k.rsplit("/", 1)[1])
                fs().get_file(k, f)
            if not Path(f).exists():
                raise RuntimeError(f"分段下載失敗:{k}")
        mb = sum(Path(f).stat().st_size for f in local) / 1e6
        # mask_space 會為整個分段算經緯度(B03 要好幾 GB);對照表本來就只取地球上的點,不需要
        scn = Scene(reader="ahi_hsd", filenames=local, reader_kwargs={"mask_space": False})
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
        return arr, mb
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
        gc.collect()


def process(stamp, band, keys):
    """紅外線頻道 → data/satellite/{band}/{stamp}.bin.gz。"""
    spec, lons, lats = band_target(band)
    arr, mb = load_band(stamp, band, keys, lons, lats, config.SAT_BANDS[band][1])
    save_grid(f"{LAYER}/{band}", stamp, arr, spec, source="JMA Himawari-9 (NOAA AWS)",
              name=f"Himawari-9 {band}", time_meaning="掃描開始時間")
    log.info("satellite %s %s 完成(下載 %.0f MB)", band, stamp, mb)


def read_grid(band, stamp):
    """已存的紅外線格點 → 亮溫 °C(第 0 列在南,缺值 NaN);沒有回傳 None。"""
    d = config.DATA_DIR / LAYER / band
    p = d / f"{stamp}.bin.gz"
    if not p.exists():
        return None
    g = json.loads((d / "index.json").read_text(encoding="utf-8"))["grid"]
    raw = np.frombuffer(gzip.decompress(p.read_bytes()), np.uint8).reshape(g["ny"], g["nx"])
    return np.where(raw == g["nodata"], np.nan, raw * g["scale"] + g["offset"]).astype(np.float32)


def process_tc(stamp, avail):
    """真實色 satellite/TC/{stamp}.webp;白天時次另存 B03 0.02° 格點 satellite/B03_2km。
    夜間部分用已存的 B07 / B13(0.02° 放大成 0.01°)。"""
    from . import truecolor
    spec, lons, lats = target(config.SAT_TC_RES)
    t07, t13 = read_grid("B07", stamp), read_grid("B13", stamp)
    def up(a):
        """0.02° → 0.01°(每格放大成 2×2;範圍不是剛好兩倍時多的裁掉、少的補 NaN)。"""
        out = np.full((spec["ny"], spec["nx"]), np.nan, np.float32)
        if a is not None:
            a = np.repeat(np.repeat(a, 2, 0), 2, 1)[:spec["ny"], :spec["nx"]]
            out[:a.shape[0], :a.shape[1]] = a
        return out
    night = truecolor.night_gray(up(t07), up(t13))[::-1]                  # 圖片方向:第 0 列在北
    day, mb = None, 0.0
    if vis_wanted(stamp):
        refl = {}
        for b in config.SAT_VIS_BANDS:
            refl[b], m = load_band(stamp, b, avail[b], lons, lats, "reflectance")
            mb += m
        # B03 0.02° 格點:0.01° 每 2×2 平均(和 B07 / B13 同格點,網頁 B03 頻道、日夜讀值用)
        res, _, scale, offset, units = config.SAT_B03
        spec03, _, _ = target(res, scale, offset, units)
        b03 = refl["B03"].reshape(spec03["ny"], 2, spec03["nx"], 2)
        with np.errstate(invalid="ignore"):
            b03 = np.nanmean(b03, axis=(1, 3))
        save_grid(f"{LAYER}/{B03}", stamp, b03, spec03, source="JMA Himawari-9 (NOAA AWS)",
                  name="Himawari-9 B03(0.02°)", time_meaning="掃描開始時間")
        when = stamp_dt(stamp).replace(tzinfo=None) + timedelta(minutes=5)     # 全盤掃到台灣附近約掃描開始 + 5 分
        day = truecolor.day_rgb({b: a[::-1] for b, a in refl.items()}, when, lons, lats[::-1])
        del refl
    img = truecolor.compose(night, day)
    buf = io.BytesIO()
    img.save(buf, "WEBP", quality=config.SAT_TC_QUALITY, method=4)
    _atomic_write(config.DATA_DIR / LAYER / TC / f"{stamp}.webp", buf.getvalue())
    update_index(f"{LAYER}/{TC}", stamp, grid={k: spec[k] for k in ("nx", "ny", "proj", "west", "east", "south", "north", "corners")},
                 format="webp", source="JMA Himawari-9 (NOAA AWS)", name="Himawari-9 真實色(日夜)",
                 time_meaning="掃描開始時間")
    log.info("satellite TC %s 完成(%s,下載 %.0f MB,%.1f MB)", stamp, "白天" if day else "夜間", mb, len(buf.getvalue()) / 1e6)
    del img, day, night
    gc.collect()


def wanted(stamp, band, have):
    if (stamp, band) in _given_up or stamp in have[band]:
        return False
    if band == TC:          # 夜間灰階要 B07;白天時次照 SAT_B03_EVERY_MIN
        return stamp in have["B07"] and (vis_wanted(stamp) or not is_day(stamp))
    return True


def ready(stamp, band, avail):
    """這個產品需要的 AWS 檔都上架了。"""
    if band == TC:
        return not vis_wanted(stamp) or all(b in avail for b in config.SAT_VIS_BANDS)
    return band in avail


def run(now=None):
    """最近 SAT_WAIT_MIN 分鐘內的時次,還沒有的產品上架了就處理。回傳處理的 [(stamp, band)]。
    每輪只處理一個時次就結束(白天真實色一筆要 1–3 分鐘),下一分鐘重新從最新的找起,
    新上架的時次才不會被舊時次卡住。順序:B13/B07/B08 由新到舊 → 都齊了才做真實色。"""
    global _since
    now = now or datetime.now(timezone.utc)
    have = {b: set(read_index(f"{LAYER}/{b}")["times"]) for b in PRODUCTS}
    t = now.replace(minute=now.minute - now.minute % 10, second=0, microsecond=0)
    wait = timedelta(minutes=config.SAT_WAIT_MIN)
    if _since is None:                                      # 重啟:從各頻道最後一筆之後補到最新
        lasts = [stamp_dt(max(v)) for v in have.values() if v]
        floor = t - timedelta(days=config.SAT_KEEP_DAYS)
        _since = max(min(lasts), floor) if lasts else t - wait
        if _since < t - wait:
            log.info("satellite 補抓 %s 之後的時次", _since.strftime("%Y%m%d%H%M"))
    slots = []                                              # 還缺產品的時次(新的先)
    old_pending = False
    slot = t
    while slot >= _since:
        stamp = slot.strftime("%Y%m%d%H%M")
        need = [b for b in PRODUCTS if wanted(stamp, b, have)]
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
    for slow in (False, True):                               # 先 B13/B07/B08,再真實色
        for stamp, need in slots:
            bands = [b for b in need if (b == TC) == slow]
            if not bands:
                continue
            if stamp not in avail_cache:
                avail_cache[stamp] = list_slot(stamp) if any(b != TC or vis_wanted(stamp) for b in bands) else {}
            avail = avail_cache[stamp]
            done = []
            for b in bands:
                prev = max(have[b], default=None)
                if not ready(stamp, b, avail):
                    _attempted.add((stamp, b))
                    continue
                try:
                    process_tc(stamp, avail) if b == TC else process(stamp, b, avail[b])
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
    """補抓舊時次。單獨執行時沒有排程幫忙 flush,每個時次處理完自己上傳 R2
    (否則 index 會被排程傳上去、檔案卻留在本機,網頁讀到 404)。"""
    t, end_dt = stamp_dt(start), stamp_dt(end)
    while t <= end_dt:
        stamp = t.strftime("%Y%m%d%H%M")
        have = {b: set(read_index(f"{LAYER}/{b}")["times"]) for b in {*bands, "B07"}}
        need = [b for b in bands if b != TC and wanted(stamp, b, have)]
        avail = list_slot(stamp) if need or TC in bands else {}
        for b in need:
            if b in avail:
                process(stamp, b, avail[b])
            else:
                log.warning("satellite %s %s:AWS 上沒有完整檔案", b, stamp)
        if TC in bands:                                      # 要先有 B07(上面剛補的也算)
            have["B07"] = set(read_index(f"{LAYER}/B07")["times"])
            if wanted(stamp, TC, have):
                if ready(stamp, TC, avail):
                    process_tc(stamp, avail)
                else:
                    log.warning("satellite TC %s:AWS 上沒有完整的 B01–B04", stamp)
        up, _ = r2.flush()
        if up:
            log.info("satellite 補抓 %s:R2 上傳 %d 檔", stamp, up)
        t += timedelta(minutes=10)
    repair_index([*bands, *([B03] if TC in bands else [])])


def repair_index(bands):
    """補抓和排程是兩個程序,同時改 index.json 可能互相蓋掉 → 依資料夾裡實際的檔補回漏掉的時次。"""
    from .common import save_json
    for band in bands:
        d = config.DATA_DIR / LAYER / band
        idx_path = d / "index.json"
        if not idx_path.exists():
            continue
        idx = json.loads(idx_path.read_text(encoding="utf-8"))
        files = {f.name[:12] for f in d.iterdir() if f.name[:12].isdigit() and not f.name.endswith(".tmp")}
        lost = files - set(idx["times"])
        if lost:
            idx["times"] = sorted(set(idx["times"]) | files)
            idx["latest"] = idx["times"][-1]
            save_json(idx_path, idx)
            log.info("satellite/%s index 補回 %d 筆", band, len(lost))
    r2.flush()


def cleanup():
    """本機(與 R2)只留 SAT_KEEP_DAYS 天;舊的 0.01° satellite/B03 也照樣清到過期。"""
    from .common import remove, save_json
    cutoff = (datetime.now(timezone.utc) - timedelta(days=config.SAT_KEEP_DAYS)).strftime("%Y%m%d%H%M")
    for band in (*PRODUCTS, B03, "B03"):
        d = config.DATA_DIR / LAYER / band
        idx_path = d / "index.json"
        if not idx_path.exists():
            continue
        idx = json.loads(idx_path.read_text(encoding="utf-8"))
        drop = {t for t in idx["times"] if t < cutoff}
        if not drop:
            continue
        for t in drop:
            for f in d.glob(f"{t}.*"):
                remove(f)
        idx["times"] = [t for t in idx["times"] if t not in drop]
        idx["fetched"] = {t: v for t, v in idx.get("fetched", {}).items() if t not in drop}
        if idx["times"]:
            idx["latest"] = idx["times"][-1]
        save_json(idx_path, idx)
        log.info("cleanup satellite/%s:刪除 %d 筆", band, len(drop))


if __name__ == "__main__":
    import logging
    logging.basicConfig(level=logging.INFO)
    ap = argparse.ArgumentParser()
    ap.add_argument("--start")
    ap.add_argument("--end")
    ap.add_argument("--bands", default=",".join(PRODUCTS))
    a = ap.parse_args()
    if a.start:
        backfill(a.start, a.end or a.start, a.bands.split(","))
    else:
        print(run())

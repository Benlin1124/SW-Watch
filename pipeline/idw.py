"""測站雨量 IDW 內插(只畫陸地)→ data/rain/idw/{acc}/{stamp}.bin.gz。"""
import numpy as np
import requests
import shapely
from scipy.spatial import cKDTree
from shapely.geometry import shape

from . import config
from .common import exists, grid_spec, log, save_grid

E = config.IDW_EXTENT
RES = config.IDW_RES
NX = int(round((E[2] - E[0]) / RES)) + 1
NY = int(round((E[3] - E[1]) / RES)) + 1
LON = E[0] + RES * np.arange(NX)
LAT = E[1] + RES * np.arange(NY)
LAT0 = (E[1] + E[3]) / 2
SPEC = grid_spec(E[0], E[1], RES, NX, NY, np.uint16, scale=0.1, offset=0.0, units="mm")


def _xy_km(lon, lat):
    return np.column_stack([(np.asarray(lon) - E[0]) * 111.32 * np.cos(np.deg2rad(LAT0)),
                            (np.asarray(lat) - E[1]) * 110.57])


def land_mask():
    """台灣(含離島)陸地遮罩,(NY, NX) bool;第一次算完存快取。"""
    path = config.CACHE_DIR / f"landmask_{NX}x{NY}.npy"
    if path.exists():
        return np.load(path)
    gj = requests.get(config.TAIWAN_GEOJSON_URL, timeout=60).json()
    lon2, lat2 = np.meshgrid(LON, LAT)
    mask = np.zeros(lon2.shape, dtype=bool)
    for f in gj["features"]:   # 原始多邊形有拓樸錯誤,逐縣市 make_valid 後各自判斷,不做 union
        mask |= shapely.contains_xy(shapely.make_valid(shape(f["geometry"])), lon2, lat2)
    path.parent.mkdir(parents=True, exist_ok=True)
    np.save(path, mask)
    return mask


def interpolate(lon, lat, val, mask):
    """kNN IDW;搜尋半徑內沒有測站的格點 → NaN。"""
    out = np.full(mask.shape, np.nan, dtype=np.float32)
    if len(val) == 0:
        return out
    tree = cKDTree(_xy_km(lon, lat))
    iy, ix = np.nonzero(mask)
    k = min(config.IDW_K, len(val))
    d, j = tree.query(_xy_km(LON[ix], LAT[iy]), k=k, distance_upper_bound=config.IDW_RADIUS_KM)
    d, j = d.reshape(len(iy), k), j.reshape(len(iy), k)
    ok = np.isfinite(d)
    vals = np.where(ok, np.append(val, 0.0)[j], 0.0)       # j == len(val) 代表沒找到鄰居
    w = np.where(ok, 1.0 / np.maximum(d, 1e-3) ** config.IDW_POWER, 0.0)
    wsum = w.sum(axis=1)
    res = np.where(wsum > 0, (w * vals).sum(axis=1) / np.where(wsum > 0, wsum, 1), np.nan)
    out[iy, ix] = res
    return out


def run(stamp, recs):
    mask = land_mask()
    for acc in config.RAIN_ACC:
        layer = f"rain/idw/{acc}"
        if exists(layer, stamp):
            continue
        pts = [(r["lon"], r["lat"], r[f"rain_{acc}"]) for r in recs
               if r.get(f"rain_{acc}") is not None]
        lon, lat, val = (np.array(x, dtype=float) for x in zip(*pts)) if pts else ([], [], [])
        grid = interpolate(lon, lat, val, mask)
        save_grid(layer, stamp, grid, SPEC, source="CWA O-A0002-001 測站 IDW",
                  name=f"測站雨量 IDW({acc})", acc=acc,
                  method=f"IDW k={config.IDW_K} p={config.IDW_POWER} r={config.IDW_RADIUS_KM}km")
    log.info("idw %s 完成", stamp)

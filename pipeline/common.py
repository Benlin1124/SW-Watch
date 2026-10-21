"""共用工具:CWA 下載、格點字串解析、量化存檔、index.json 維護。"""
import gzip
import json
import logging
import os
import re
import time
from datetime import datetime, timezone

import numpy as np
import requests

from . import config

log = logging.getLogger("pipeline")


# ── 時間 ─────────────────────────────────────────────
def utc_stamp(iso):
    """'2026-10-22T00:20:00+08:00' → '202610211620'(UTC,檔名一律用 UTC)。"""
    dt = datetime.fromisoformat(iso).astimezone(timezone.utc)
    return dt.strftime("%Y%m%d%H%M")


# ── 下載 ─────────────────────────────────────────────
def fetch_cwa(code, retries=3, timeout=90):
    """抓 CWA fileapi JSON,回傳 cwaopendata 底下的 dict。"""
    if not config.CWA_KEY:
        raise RuntimeError("未設定 CWA_KEY(請在專案根目錄 .env 加上 CWA_KEY=...)")
    url = config.CWA_FILEAPI.format(code=code, key=config.CWA_KEY)
    for i in range(retries):
        try:
            r = requests.get(url, timeout=timeout, allow_redirects=True)
            r.raise_for_status()
            return r.json()["cwaopendata"]
        except Exception as e:
            log.warning("%s 第 %d 次失敗:%s", code, i + 1, e)
            time.sleep(5 * (i + 1))
    raise RuntimeError(f"{code} 下載失敗")


def parse_grid(text, nx, ny, invalid=()):
    """CWA 逗號分隔科學記號字串 → (ny, nx) float32;第 0 列為最南。invalid 內的值改 NaN。"""
    # 有的產品只用逗號分隔,O-A0040-004 同一列內用空白分隔 → 逗號或空白一律切開
    arr = np.array(re.split(r"[,\s]+", text.strip().strip(",")), dtype=np.float32)
    if arr.size != nx * ny:
        raise ValueError(f"格點數 {arr.size} != {nx}x{ny}")
    arr = arr.reshape(ny, nx)
    for v in invalid:
        arr[np.isclose(arr, v)] = np.nan
    return arr


def grid_spec(lon0, lat0, dx, nx, ny, dtype, scale, offset, units, twd67=False, dy=None):
    """格點規格(寫進 index.json 給前端用)。lon0/lat0 = 左下角格點中心(WGS84)。"""
    if twd67:
        lon0, lat0 = lon0 + config.TWD67_DLON, lat0 + config.TWD67_DLAT
    nodata = int(np.iinfo(dtype).max)
    return dict(lon0=round(lon0, 5), lat0=round(lat0, 5), dx=dx, dy=dy or dx, nx=nx, ny=ny,
                dtype=np.dtype(dtype).name, scale=scale, offset=offset, nodata=nodata,
                units=units, origin="lower-left")


def quantize(arr, spec):
    """實際值 → 整數:raw = round((v - offset) / scale),NaN → nodata。"""
    nodata = spec["nodata"]
    raw = np.round((arr - spec["offset"]) / spec["scale"])
    raw = np.clip(raw, 0, nodata - 1)
    raw[np.isnan(arr)] = nodata
    return raw.astype(spec["dtype"])


# ── 存檔 ─────────────────────────────────────────────
def _atomic_write(path, data: bytes):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def save_json(path, obj, gz=False):
    data = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    _atomic_write(path, gzip.compress(data, 6) if gz else data)


def layer_dir(layer):
    return config.DATA_DIR / layer


def exists(layer, stamp, ext=".bin.gz"):
    return (layer_dir(layer) / f"{stamp}{ext}").exists()


def update_index(layer, stamp, **meta):
    """把 stamp 加進 data/{layer}/index.json 的 times(排序去重),並更新 meta 欄位。"""
    path = layer_dir(layer) / "index.json"
    idx = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"times": []}
    idx.update(meta)
    idx["layer"] = layer
    idx["times"] = sorted(set(idx["times"]) | {stamp})
    idx["latest"] = idx["times"][-1]
    idx["updated"] = datetime.now(timezone.utc).strftime("%Y%m%d%H%M")
    save_json(path, idx)


def save_grid(layer, stamp, arr, spec, **meta):
    """量化 → gzip → data/{layer}/{stamp}.bin.gz,並更新 index。"""
    raw = quantize(arr, spec)
    _atomic_write(layer_dir(layer) / f"{stamp}.bin.gz", gzip.compress(raw.tobytes(), 6))
    update_index(layer, stamp, grid=spec, **meta)


def save_points(layer, stamp, obj, **meta):
    save_json(layer_dir(layer) / f"{stamp}.json", obj)
    update_index(layer, stamp, **meta)

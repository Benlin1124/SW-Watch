"""共用工具:CWA 下載、格點字串解析、座標轉換、量化存檔、index.json 維護、更新狀態紀錄。"""
import csv
import gzip
import json
import logging
import os
import re
from datetime import datetime, timezone

import numpy as np
import pyproj
import requests

from . import config

log = logging.getLogger("pipeline")


# ── 時間 ─────────────────────────────────────────────
def utc_stamp(iso):
    """'2026-10-22T00:20:00+08:00' → '202610211620'(UTC,檔名一律用 UTC)。"""
    dt = datetime.fromisoformat(iso).astimezone(timezone.utc)
    return dt.strftime("%Y%m%d%H%M")


def now_stamp(seconds=False):
    return datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S" if seconds else "%Y%m%d%H%M")


def stamp_dt(stamp):
    return datetime.strptime(stamp[:12], "%Y%m%d%H%M").replace(tzinfo=timezone.utc)


# ── 座標 ─────────────────────────────────────────────
_TWD67 = pyproj.Transformer.from_crs(pyproj.CRS(config.TWD67_PROJ), "EPSG:4326", always_xy=True)


def twd67_to_wgs84(lon, lat):
    """TWD67 經緯度 → WGS84(七參數 Helmert,見 config.TWD67_PROJ)。可吃純量或陣列。"""
    return _TWD67.transform(lon, lat)


# ── 下載 ─────────────────────────────────────────────
def fetch_cwa(code, timeout=90):
    """抓 CWA fileapi JSON,回傳 cwaopendata 底下的 dict。
    只請求一次;失敗由排程在 RETRY_DELAY_SEC 後重試(CWA API 有請求次數上限)。"""
    if not config.CWA_KEY:
        raise RuntimeError("未設定 CWA_KEY(請在專案根目錄 .env 加上 CWA_KEY=...)")
    url = config.CWA_FILEAPI.format(code=code, key=config.CWA_KEY)
    r = requests.get(url, timeout=timeout, allow_redirects=True)
    r.raise_for_status()
    return r.json()["cwaopendata"]


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
    """格點規格(寫進 index.json 給前端用)。
    lon0/lat0 = 原始座標系的左下角格點中心;corners = 格點外框四角(WGS84,
    順序 左上、右上、右下、左下,即 MapLibre image source 的 coordinates)。
    TWD67 格點逐角做七參數轉換;整個雷達範圍內位移差異 < 0.0007°(< 1/15 格),四角定位即可。"""
    dy = dy or dx
    w, e = lon0 - dx / 2, lon0 + dx * (nx - 0.5)
    s, n = lat0 - dy / 2, lat0 + dy * (ny - 0.5)
    corners = [(w, n), (e, n), (e, s), (w, s)]
    if twd67:
        lons, lats = twd67_to_wgs84([c[0] for c in corners], [c[1] for c in corners])
        corners = list(zip(lons, lats))
    nodata = int(np.iinfo(dtype).max)
    return dict(lon0=lon0, lat0=lat0, dx=dx, dy=dy, nx=nx, ny=ny,
                datum="TWD67" if twd67 else "WGS84",
                corners=[[round(x, 6), round(y, 6)] for x, y in corners],
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


def read_index(layer):
    path = layer_dir(layer) / "index.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"times": []}


def update_index(layer, stamp, **meta):
    """把 stamp 加進 data/{layer}/index.json 的 times(排序去重),並更新 meta 欄位。
    fetched[stamp] = 這筆資料實際抓到的時間(UTC 到秒),可算出上架延遲。"""
    idx = read_index(layer)
    idx.update(meta)
    idx["layer"] = layer
    idx["times"] = sorted(set(idx["times"]) | {stamp})
    idx["latest"] = idx["times"][-1]
    idx.setdefault("fetched", {})[stamp] = now_stamp(seconds=True)
    idx["updated"] = now_stamp(seconds=True)
    save_json(layer_dir(layer) / "index.json", idx)


# ── 更新檢查與狀態紀錄 ─────────────────────────────────
def check_update(layer, stamp, ext=".bin.gz"):
    """和上一筆比較:回傳 (狀態, 上一筆時間)。
    new = 比上一筆新;same = 和上一筆相同(來源尚未更新,排程再依時間判斷是否為 late 逾時);
    older = 比上一筆舊(來源異常);
    exists = 不是最新但檔案已存在(例如補抓)。"""
    prev = read_index(layer).get("latest")
    if prev and stamp == prev:
        return "same", prev
    if exists(layer, stamp, ext):
        return "exists", prev
    if prev and stamp < prev:
        return "older", prev
    return "new", prev


STATUS_PATH = config.DATA_DIR / "status.json"
HISTORY_PATH = config.LOG_DIR / "fetch_history.csv"
HISTORY_FIELDS = ["check_time", "job", "attempt", "status", "data_time", "prev_time",
                  "delay_min", "error"]


def record_status(job, status, data_time=None, prev_time=None, attempt=0, error=None):
    """每次抓取都記錄:
    data/status.json        每個工作的最新狀態(前端可顯示資料是否過期)
    logs/fetch_history.csv  每次檢查一列(檢查時間、資料時間、是否為新資料、延遲)"""
    now = now_stamp(seconds=True)
    delay = None
    if data_time:
        delay = round((stamp_dt(now) - stamp_dt(data_time)).total_seconds() / 60, 1)

    st = json.loads(STATUS_PATH.read_text(encoding="utf-8")) if STATUS_PATH.exists() else {}
    s = st.setdefault(job, {})
    s.update(last_check=now, status=status, attempt=attempt)
    if data_time:
        s["data_time"] = data_time
    if status == "new":
        s.update(prev_data_time=prev_time, last_new=now, delay_min=delay, stale_checks=0,
                 fail_count=0)
    elif status in ("same", "late"):
        s["stale_checks"] = s.get("stale_checks", 0) + 1
    if status == "error":
        s["fail_count"] = s.get("fail_count", 0) + 1
        s.update(last_error=error, last_error_time=now)
    save_json(STATUS_PATH, st)

    HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
    new_file = not HISTORY_PATH.exists()
    with open(HISTORY_PATH, "a", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        if new_file:
            w.writerow(HISTORY_FIELDS)
        w.writerow([now, job, attempt, status, data_time or "", prev_time or "",
                    "" if delay is None else delay, (error or "")[:200]])


def save_grid(layer, stamp, arr, spec, **meta):
    """量化 → gzip → data/{layer}/{stamp}.bin.gz,並更新 index。"""
    raw = quantize(arr, spec)
    _atomic_write(layer_dir(layer) / f"{stamp}.bin.gz", gzip.compress(raw.tobytes(), 6))
    update_index(layer, stamp, grid=spec, **meta)


def save_points(layer, stamp, obj, **meta):
    save_json(layer_dir(layer) / f"{stamp}.json", obj)
    update_index(layer, stamp, **meta)

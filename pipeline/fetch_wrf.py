"""氣象署 WRF 區域模式 3 公里(M-A0064,開放資料):降雨、2 m 溫度、10 m 風、海平面氣壓;每 6 小時一步、0–84 小時。
  data/wrf/index.json              times = 起報時間(stamp);grid、vars、steps(格式同 data/ecmwf,網頁共用)
  data/wrf/{起報}/{變數}.bin.gz    uint16 (步數, ny, nx),第 0 列最南;實際值 = raw * scale + offset,65535 = 無資料
來源:cwaopendata S3 公開網址 Model/M-A0064-{step:03d}.grb2(fileapi 只是轉址到這裡,不計會員次數)。
  每個時刻一個檔約 180 MB(11 層高空 + 地面共 78 欄),S3 只留最新一報、逐檔覆蓋(起報後約 5–6 小時上完)。
  用 HTTP Range 讀每欄開頭幾百 byte 認欄位,只下載需要的 5 欄(每欄約 2.3 MB)→ 一報約 175 MB 下載。
網格:原始是 Lambert 投影 1158×673(3 km),雙線性內插到 0.03° 經緯度、範圍同 ECMWF(config.ECMWF_AREA),
  本機和 R2 每報約 10 MB。風是地理方向(uvRelativeToGrid = 0),不用轉。
  tp:每個檔已是起報後累積(stepRange 0-6、0-84…),和 ECMWF 一樣由網頁相減得到各時段雨量。
排程每 10 分鐘檢查:15 個檔的 json(各 1 KB)起報時間都相同、而且比已抓的新 → 抓。
手動:python -m pipeline.fetch_wrf"""
import gzip
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import requests

from . import config, r2
from .common import _atomic_write, grid_spec, layer_dir, log, quantize, read_index, update_index
from .fetch_ecmwf import cleanup as _cleanup

LAYER = "wrf"
CODE = "M-A0064"
S3 = "https://cwaopendata.s3.ap-northeast-1.amazonaws.com/Model"
STEPS = list(range(0, 85, 6))
RES = 0.03
# 變數 → ((discipline, category, number, 第一層面類型, 層值), 換算, 量化 scale, offset, 單位, 名稱)
VARS = {
    "msl": ((0, 3, 1, 101, None), lambda v: v / 100, 0.1, 800.0, "hPa", "海平面氣壓"),
    "t2": ((0, 0, 0, 103, 2), lambda v: v - 273.15, 0.01, -60.0, "°C", "2 m 溫度"),
    "u10": ((0, 2, 2, 103, 10), None, 0.01, -300.0, "m/s", "10 m 東西風"),
    "v10": ((0, 2, 3, 103, 10), None, 0.01, -300.0, "m/s", "10 m 南北風"),
    "tp": ((0, 1, 8, 1, None), None, 0.1, 0.0, "mm", "起報後累積雨量"),
}
HEAD = 512                      # 每欄讀多少 byte 來認欄位(第 0–4 段)
session = requests.Session()


def _url(step, ext):
    return f"{S3}/{CODE}-{step:03d}.{ext}"


def _get(url, headers=None, tries=5):
    last = None
    for k in range(tries):
        try:
            r = session.get(url, headers=headers, timeout=120)
            if r.status_code in (200, 206):
                return r
            last = f"HTTP {r.status_code}"
        except requests.RequestException as e:
            last = f"{type(e).__name__}: {e}"
        time.sleep(min(5 * 2 ** k, 60))
    raise RuntimeError(f"WRF {url} 下載失敗:{last}")


def init_of(step):
    """這個時刻的檔目前是哪一報(json 的 InitialTime,YYYYMMDDHHMM)。"""
    return _get(_url(step, "json")).json()["cwaopendata"]["dataset"]["datasetInfo"]["InitialTime"]


def available():
    """15 個檔都是同一報 → 回傳起報時間;還在更新中(新舊混雜)→ None。"""
    inits = {init_of(s) for s in STEPS}
    return inits.pop() if len(inits) == 1 else None


def _sections(b):
    """GRIB2 第 1–4 段的位置 {段號: 起點};b 是一欄開頭的 bytes。"""
    out, p = {}, 16
    while p + 5 <= len(b):
        n, num = int.from_bytes(b[p:p + 4], "big"), b[p + 4]
        out[num] = p
        if num >= 4 or n == 0:
            break
        p += n
    return out


def scan(step, want):
    """依序讀每欄開頭,找出 want 裡各欄位的 (offset, length, 起報時間)。"""
    found, off = {}, 0
    while len(found) < len(want):
        b = _get(_url(step, "grb2"), {"Range": f"bytes={off}-{off + HEAD - 1}"}).content
        if len(b) < 16:
            break
        if b[:4] != b"GRIB":
            raise RuntimeError(f"WRF +{step}h offset {off} 不是 GRIB 開頭")
        length = int.from_bytes(b[8:16], "big")
        sec = _sections(b)
        if 4 not in sec:
            raise RuntimeError(f"WRF +{step}h offset {off} 讀不到第 4 段")
        s1, s4 = sec[1], sec[4]
        init = "%04d%02d%02d%02d%02d" % (int.from_bytes(b[s1 + 12:s1 + 14], "big"), *b[s1 + 14:s1 + 18])
        key = (b[6], b[s4 + 9], b[s4 + 10], b[s4 + 22])
        level = int.from_bytes(b[s4 + 24:s4 + 28], "big") / 10 ** b[s4 + 23]
        for var, ((d, c, n, t, lv), *_r) in want.items():
            if var not in found and key == (d, c, n, t) and (lv is None or level == lv):
                found[var] = (off, length, init)
        off += length
    return found


class Regrid:
    """Lambert 網格 → 0.03° 經緯度(範圍同 ECMWF)的雙線性內插;第一次用一欄的投影參數建表。"""

    def __init__(self, h):
        import eccodes
        from pyproj import Proj
        g = lambda k: eccodes.codes_get(h, k)
        if g("gridType") != "lambert" or g("jScansPositively") != 1 or g("iScansNegatively") != 0:
            raise RuntimeError("WRF 網格不是由南往北、由西往東的 Lambert")
        self.ni, self.nj = g("Ni"), g("Nj")
        r = g("radius") if eccodes.codes_is_defined(h, "radius") else 6371229.0
        p = Proj(proj="lcc", lat_1=g("Latin1InDegrees"), lat_2=g("Latin2InDegrees"), lat_0=g("LaDInDegrees"),
                 lon_0=g("LoVInDegrees"), R=r)
        x0, y0 = p(g("longitudeOfFirstGridPointInDegrees"), g("latitudeOfFirstGridPointInDegrees"))
        w, s, e, n = config.ECMWF_AREA
        self.nx, self.ny = round((e - w) / RES) + 1, round((n - s) / RES) + 1
        lon, lat = np.meshgrid(w + np.arange(self.nx) * RES, s + np.arange(self.ny) * RES)
        x, y = p(lon, lat)
        fi, fj = (x - x0) / g("DxInMetres"), (y - y0) / g("DyInMetres")
        if fi.min() < 0 or fj.min() < 0 or fi.max() > self.ni - 1 or fj.max() > self.nj - 1:
            raise RuntimeError("WRF 網格沒有涵蓋 ECMWF_AREA")
        self.i0 = np.minimum(fi.astype(int), self.ni - 2)
        self.j0 = np.minimum(fj.astype(int), self.nj - 2)
        self.ti, self.tj = (fi - self.i0).astype(np.float32), (fj - self.j0).astype(np.float32)

    def __call__(self, v):
        v = v.reshape(self.nj, self.ni)
        i, j, ti, tj = self.i0, self.j0, self.ti, self.tj
        return ((v[j, i] * (1 - ti) + v[j, i + 1] * ti) * (1 - tj)
                + (v[j + 1, i] * (1 - ti) + v[j + 1, i + 1] * ti) * tj).astype(np.float32)


_regrid = None
_eccodes_lock = threading.Lock()          # ecCodes 第一次載入定義檔不是執行緒安全:解碼一次一個(下載仍並行)


def _field(step, off, length):
    import eccodes
    global _regrid
    r = _get(_url(step, "grb2"), {"Range": f"bytes={off}-{off + length - 1}"})
    if len(r.content) != length:
        raise RuntimeError(f"WRF +{step}h offset {off} 下載不完整")
    with _eccodes_lock:
        h = eccodes.codes_new_from_message(r.content)
        try:
            if _regrid is None:
                _regrid = Regrid(h)
            v = eccodes.codes_get_values(h)
        finally:
            eccodes.codes_release(h)
    return _regrid(v)


def locate(step, init):
    """一個時刻要抓的欄位位置;缺欄位或檔案已換成下一報 → 丟錯(整報下次再試)。"""
    want = {k: v for k, v in VARS.items() if not (k == "tp" and step == 0)}     # 0 小時沒有雨量
    found = scan(step, want)
    missing = set(want) - set(found)
    if missing:
        raise RuntimeError(f"WRF +{step}h 找不到 {'、'.join(sorted(missing))}")
    bad = {i for _o, _l, i in found.values()} - {init}
    if bad:
        raise RuntimeError(f"WRF +{step}h 已換成 {bad.pop()} 報(要抓 {init}),下次再試")
    return found


def process(init):
    t0 = time.time()
    log.info("WRF 3km %s 開始下載(%d 步,約 175 MB)", init, len(STEPS))
    with ThreadPoolExecutor(8) as pool:                  # 認欄位:每檔要依序讀約 78 次開頭,各檔同時讀
        where = dict(zip(STEPS, pool.map(lambda s: locate(s, init), STEPS)))
    with ThreadPoolExecutor(4) as pool:
        jobs = {(s, k): pool.submit(_field, s, o, n) for s in STEPS for k, (o, n, _i) in where[s].items()}
        data = {k: [] for k in VARS}
        for s in STEPS:
            for k, (_p, conv, *_r) in VARS.items():
                v = jobs[(s, k)].result() if (s, k) in jobs else None
                data[k].append(conv(v) if conv and v is not None else v)
    shape = data["msl"][0].shape
    data["tp"][0] = np.zeros(shape, np.float32)
    w, s, _e, _n = config.ECMWF_AREA
    ny, nx = shape
    grid = grid_spec(w, s, RES, nx, ny, np.uint16, 1, 0, "")
    grid.update(west=w - RES / 2, east=w + (nx - 0.5) * RES, south=s - RES / 2, north=s + (ny - 0.5) * RES)
    for k in ("scale", "offset", "units"):
        grid.pop(k)
    vars_ = {k: dict(scale=sc, offset=off, units=u, name=name, dtype="uint16", nodata=65535)
             for k, (_p, _c, sc, off, u, name) in VARS.items()}
    out_dir = layer_dir(LAYER) / init
    for k, arrs in data.items():
        raw = quantize(np.stack(arrs), vars_[k])
        _atomic_write(out_dir / f"{k}.bin.gz", gzip.compress(raw.tobytes(), 6))
    update_index(LAYER, init, grid=grid, vars=vars_, steps=STEPS, name="氣象署 WRF 3 km",
                 source="中央氣象署 區域預報模式 WRF 3 公里(M-A0064,政府資料開放授權)")
    log.info("WRF 3km %s 完成:%.0f 秒", init, time.time() - t0)
    return init


def run():
    """S3 上整報都換新、而且還沒抓 → 抓。回傳 (狀態, 起報, 上一報)。"""
    have = read_index(LAYER)["times"]
    prev = max(have) if have else None
    init = available()
    if not init or init in have or (prev and init < prev):
        return "same", prev, prev
    process(init)
    cleanup()
    return "new", init, prev


def cleanup():
    _cleanup(LAYER, "WRF")


if __name__ == "__main__":
    import logging
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    print(run())
    r2.flush()

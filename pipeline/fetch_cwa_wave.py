"""氣象署海浪模式(開放資料 F-A0020-001):浪高、浪向(來向)、平均週期;0.1°、逐時 0–168 小時,一天 4 報。
  data/cwawave/index.json              times = 起報時間(stamp);grid、vars、steps(格式同 data/ecmwf,網頁共用)
  data/cwawave/{起報}/{變數}.bin.gz    uint16 (步數, ny, nx),第 0 列最南;實際值 = raw * scale + offset,65535 = 無資料
來源:cwaopendata S3 公開網址 Forecast/F-A0020-001.zip(fileapi 只是轉址到這裡,不計會員次數),約 58 MB,
  內含 169 個時刻 × 3 變數的 XML(每檔約 5 MB,陸地點不列)。S3 只留最新一報。
  先 HEAD 比對 ETag,沒變就不下載。
檔案說明(DatasetDescription、ElementDescription)是亂碼,欄位意義用和 ECMWF 同時刻比對確認:
  WaveDirection 和 ECMWF mwd 中位差 2°(來向);WavePeriod 平均比 ECMWF 尖峰週期短約 1.6 s → 當平均週期;
  Measures 寫 0.01m / 0.01s,但數值已是 m / s。
範圍:資料有值的 110–126°E、9.5–36°N 全部保留(AREA,163 × 268 格)。
手動:python -m pipeline.fetch_cwa_wave"""
import gzip
import io
import re
import time
import zipfile

import numpy as np
import requests

from . import r2
from .common import _atomic_write, grid_spec, layer_dir, log, quantize, read_index, save_json, update_index
from .fetch_ecmwf import cleanup as _cleanup, legacy_grids

LAYER = "cwawave"
URL = "https://cwaopendata.s3.ap-northeast-1.amazonaws.com/Forecast/F-A0020-001.zip"
RES = 0.1
AREA = (110.0, 9.5, 126.0, 36.0)   # 資料有值的範圍(西、南、東、北格點)
# 變數 → (XML 檔名代號, 量化 scale, offset, 單位, 名稱)
VARS = {
    "swh": ("hs", 0.01, 0.0, "m", "浪高"),
    "mwd": ("dir", 0.01, 0.0, "°", "浪向(來向)"),
    "mwp": ("t", 0.01, 0.0, "s", "平均週期"),
}
PAT = re.compile(rb"<Latitude>([-\d.]+)</Latitude>\s*<Longitude>([-\d.]+)</Longitude>\s*<\w+>([^<]*)<")
NAME = re.compile(r"^(\d{8})-(\w+)\.(\d{3})\.xml$")


def _init(b):
    """XML 的 InitialTime(UTC,'2026-10-27 18:00:00')→ stamp。"""
    s = re.search(rb"<InitialTime>(.*?)</InitialTime>", b).group(1).decode()
    return re.sub(r"\D", "", s)[:12]


def parse(zf, grid_shape):
    """zip 內全部 XML → {變數: (步數, ny, nx)}、steps、起報。"""
    files = {}
    for n in zf.namelist():
        m = NAME.match(n)
        if m:
            files.setdefault(m.group(2), {})[int(m.group(3))] = n
    steps = sorted(files.get("hs", {}))
    if not steps or any(sorted(files.get(code, {})) != steps for code, *_ in VARS.values()):
        raise RuntimeError("F-A0020-001 zip 內各變數時刻不一致")
    ny, nx = grid_shape
    w, s, _e, _n = AREA
    init, out = None, {}
    for var, (code, *_r) in VARS.items():
        arr = np.full((len(steps), ny, nx), np.nan, np.float32)
        for k, step in enumerate(steps):
            b = zf.read(files[code][step])
            i = _init(b)
            if init is None:
                init = i
            elif i != init:
                raise RuntimeError(f"F-A0020-001 {files[code][step]} 起報 {i} 和 {init} 不同")
            for la, lo, v in PAT.findall(b):
                r, c = round((float(la) - s) / RES), round((float(lo) - w) / RES)
                if 0 <= r < ny and 0 <= c < nx and v.strip():
                    arr[k, r, c] = float(v)
        out[var] = arr
    return out, steps, init


def grid_and_vars():
    w, s, e, n = AREA
    nx, ny = round((e - w) / RES) + 1, round((n - s) / RES) + 1
    g = grid_spec(w, s, RES, nx, ny, np.uint16, 1, 0, "")
    g.update(west=w - RES / 2, east=w + (nx - 0.5) * RES, south=s - RES / 2, north=s + (ny - 0.5) * RES)
    for k in ("scale", "offset", "units"):
        g.pop(k)
    vars_ = {k: dict(scale=sc, offset=off, units=u, name=name, dtype="uint16", nodata=65535)
             for k, (_c, sc, off, u, name) in VARS.items()}
    return g, vars_


def run():
    """S3 的 zip 換了(ETag)而且是新的一報 → 抓。回傳 (狀態, 起報, 上一報)。"""
    idx = read_index(LAYER)
    have = idx["times"]
    prev = max(have) if have else None
    h = requests.head(URL, timeout=60)
    h.raise_for_status()
    etag = h.headers.get("ETag", "")
    if etag and etag == idx.get("etag"):
        return "same", prev, prev
    t0 = time.time()
    r = requests.get(URL, timeout=600)
    r.raise_for_status()
    grid, vars_ = grid_and_vars()
    data, steps, init = parse(zipfile.ZipFile(io.BytesIO(r.content)), (grid["ny"], grid["nx"]))
    if init in have or (prev and init < prev):
        if have:                                   # 記下 ETag,下次不用再下載同一個 zip
            idx["etag"] = etag
            save_json(layer_dir(LAYER) / "index.json", idx)
        return "same", prev, prev
    out_dir = layer_dir(LAYER) / init
    for k, arr in data.items():
        _atomic_write(out_dir / f"{k}.bin.gz", gzip.compress(quantize(arr, vars_[k]).tobytes(), 6))
    update_index(LAYER, init, grid=grid, grids=legacy_grids(LAYER, grid), vars=vars_, steps=steps, etag=etag, name="氣象署海浪模式",
                 source="中央氣象署 海浪模式(F-A0020-001,政府資料開放授權)")
    log.info("氣象署海浪 %s 完成:%d 步,下載 %.0f MB,%.0f 秒", init, len(steps), len(r.content) / 1e6, time.time() - t0)
    cleanup()
    return "new", init, prev


def cleanup():
    _cleanup(LAYER, "氣象署海浪")


if __name__ == "__main__":
    import logging
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    print(run())
    r2.flush()

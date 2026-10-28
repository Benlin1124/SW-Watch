"""ECMWF AIFS(AI 模式,aifs-single)開放資料:降雨、2 m 溫度、10 m 風、海平面氣壓、海浪;0.25°、每 6 小時、0–84 小時,一天 4 報。
  data/aifs/index.json              times = 起報時間(stamp);grid、vars、steps(格式同 data/ecmwf,網頁共用)
  data/aifs/{起報}/{變數}.bin.gz    uint16 (步數, ny, nx),第 0 列最南;實際值 = raw * scale + offset,65535 = 無資料
路徑:{host}/{YYYYMMDD}/{HH}z/aifs-single/0p25/{oper|wave}/{YYYYMMDDHH}0000-{step}h-{oper|wave}-fc.{index|grib2},和 IFS 同站。
  tp 是起報後累積,單位已是 mm(kg m-2;IFS 的 tp 是 m)。
  海浪(stream wave):swh 浪高、mwd 平均波向(來向)、mwp 平均週期(沒有尖峰週期;陸地 = 無資料)。開放資料沒有陣風。
下載:依 .index 用 HTTP Range 只抓 8 欄(每欄全球約 0.3–0.6 MB),一報約 55 MB;只留台灣附近(config.ECMWF_AREA)。
排程每 10 分鐘檢查:84 小時檔上架了就抓(新的優先);起報 24 小時內漏掉的報重啟後會補。
手動:python -m pipeline.fetch_aifs [--init 2026102712]"""
import argparse
import gzip
import json
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import numpy as np
import requests

from . import config, r2
from .common import _atomic_write, grid_spec, layer_dir, log, quantize, read_index, update_index
from .fetch_ecmwf import HOSTS, _crop_slices, cleanup as _cleanup, stamp_of

LAYER = "aifs"
RES = 0.25
STEPS = list(range(0, config.ECMWF_MAX_STEP + 1, 6))
RUNS = (0, 6, 12, 18)
WAIT_H = 4                     # 起報後幾小時才開始檢查
# 變數 → (AIFS param, 換算, 量化 scale, offset, 單位, 名稱)
VARS = {
    "msl": ("msl", lambda v: v / 100, 0.1, 800.0, "hPa", "海平面氣壓"),
    "t2": ("2t", lambda v: v - 273.15, 0.01, -60.0, "°C", "2 m 溫度"),
    "u10": ("10u", None, 0.01, -300.0, "m/s", "10 m 東西風"),
    "v10": ("10v", None, 0.01, -300.0, "m/s", "10 m 南北風"),
    "tp": ("tp", None, 0.1, 0.0, "mm", "起報後累積雨量"),
    "swh": ("swh", None, 0.01, 0.0, "m", "示性波高"),
    "mwd": ("mwd", None, 0.01, 0.0, "°", "平均波向(來向)"),
    "mwp": ("mwp", None, 0.01, 0.0, "s", "平均週期"),
}
WAVE = {"swh", "mwd", "mwp"}                # 在海浪的檔(stream wave),其餘在大氣(oper)
STREAMS = ("oper", "wave")


def _url(host, init, step, ext, stream="oper"):
    d, h = init.strftime("%Y%m%d"), init.strftime("%H")
    return f"{host}/{d}/{h}z/aifs-single/0p25/{stream}/{d}{h}0000-{step}h-{stream}-fc.{ext}"


def _get(init, step, ext, headers=None, tries=6, stream="oper"):
    """依序試各來源;忙碌或連線失敗就等一下再試。404 直接回 None。"""
    last = None
    for k in range(tries):
        try:
            r = requests.get(_url(HOSTS[k % len(HOSTS)], init, step, ext, stream), headers=headers, timeout=120)
            if r.status_code == 404:
                return None
            if r.status_code in (200, 206):
                return r
            last = f"HTTP {r.status_code}"
        except requests.RequestException as e:
            last = f"{type(e).__name__}: {e}"
        time.sleep(min(5 * 2 ** k, 60))
    raise RuntimeError(f"AIFS {stamp_of(init)} +{step}h {ext} 下載失敗:{last}")


def available(init):
    """大氣和海浪最後一步的 index 都上架了 → 這一報可以抓。"""
    def up(stream):
        for host in HOSTS:
            try:
                r = requests.head(_url(host, init, STEPS[-1], "index", stream), timeout=30)
                if r.status_code in (200, 404):
                    return r.status_code == 200
            except requests.RequestException:
                continue
        return False
    return all(up(s) for s in STREAMS)


def _field(init, step, entry):
    import eccodes
    a, n = entry["_offset"], entry["_length"]
    r = _get(init, step, "grib2", headers={"Range": f"bytes={a}-{a + n - 1}"}, stream=entry["stream"])
    if r is None or len(r.content) != n:
        raise RuntimeError(f"AIFS {stamp_of(init)} +{step}h {entry['param']} 下載不完整")
    h = eccodes.codes_new_from_message(r.content)
    try:
        ni, nj, rs, cs = _crop_slices(h)
        v = eccodes.codes_get_values(h).reshape(nj, ni)[rs, cs].astype(np.float32)
        if eccodes.codes_get(h, "bitmapPresent"):
            v[v == eccodes.codes_get(h, "missingValue")] = np.nan
    finally:
        eccodes.codes_release(h)
    return v[::-1]


def fetch_step(init, step, pool):
    entries = {}
    for stream in STREAMS:
        r = _get(init, step, "index", stream=stream)
        if r is None:
            raise RuntimeError(f"AIFS {stamp_of(init)} +{step}h {stream} 尚未上架")
        for e in map(json.loads, r.text.splitlines()):
            if e.get("levtype") == "sfc":
                entries[(stream, e["param"])] = dict(e, stream=stream)
    jobs = {}
    for var, (p, *_r) in VARS.items():
        e = entries.get(("wave" if var in WAVE else "oper", p))
        if e is not None and not (var == "tp" and step == 0):
            jobs[var] = pool.submit(_field, init, step, e)
    out = {}
    for var, (_p, conv, *_r) in VARS.items():
        v = jobs[var].result() if var in jobs else None
        out[var] = conv(v) if conv and v is not None else v
    return out


def process(init):
    t0 = time.time()
    stamp = stamp_of(init)
    log.info("AIFS %s 開始下載(%d 步,約 55 MB)", stamp, len(STEPS))
    data = {k: [] for k in VARS}
    # ecCodes 第一次載入定義檔不是執行緒安全:先在主執行緒解一步(fetch_wrf 同樣的問題)
    with ThreadPoolExecutor(1) as one:
        first = fetch_step(init, STEPS[0], one)
    with ThreadPoolExecutor(4) as pool:
        for step in STEPS:
            got = first if step == STEPS[0] else fetch_step(init, step, pool)
            for k in VARS:
                data[k].append(got[k])
    shape = data["msl"][0].shape
    data["tp"][0] = np.zeros(shape, np.float32)          # 起報時累積雨量 = 0
    missing = [k for k, arrs in data.items() if any(a is None for a in arrs)]
    if missing:
        raise RuntimeError(f"AIFS {stamp} 缺欄位:{'、'.join(missing)}")
    w, s, _e, _n = config.ECMWF_AREA
    ny, nx = shape
    grid = grid_spec(w, s, RES, nx, ny, np.uint16, 1, 0, "")
    grid.update(west=w - RES / 2, east=w + (nx - 0.5) * RES, south=s - RES / 2, north=s + (ny - 0.5) * RES)
    for k in ("scale", "offset", "units"):
        grid.pop(k)
    vars_ = {k: dict(scale=sc, offset=off, units=u, name=name, dtype="uint16", nodata=65535)
             for k, (_p, _c, sc, off, u, name) in VARS.items()}
    out_dir = layer_dir(LAYER) / stamp
    for k, arrs in data.items():
        _atomic_write(out_dir / f"{k}.bin.gz", gzip.compress(quantize(np.stack(arrs), vars_[k]).tobytes(), 6))
    update_index(LAYER, stamp, grid=grid, vars=vars_, steps=STEPS, name="ECMWF AIFS 預報",
                 source="ECMWF open data AIFS single 0.25°(CC BY 4.0)")
    log.info("AIFS %s 完成:%d 步,%.0f 秒", stamp, len(STEPS), time.time() - t0)
    return stamp


def candidates(now):
    """保留期間內的 00/06/12/18Z 起報,新的在前。"""
    t = now.replace(minute=0, second=0, microsecond=0)
    t -= timedelta(hours=t.hour % 6)
    out = []
    while t > now - timedelta(days=config.ECMWF_KEEP_DAYS):
        if t.hour in RUNS:
            out.append(t)
        t -= timedelta(hours=6)
    return out


def run(now=None):
    """還沒抓的報(新的優先)上架了就抓一報。回傳 (狀態, 起報, 上一報)。起報 24 小時後仍沒上架就不再查。"""
    now = now or datetime.now(timezone.utc)
    have = set(read_index(LAYER)["times"])
    prev = max(have) if have else None
    for init in candidates(now):
        stamp = stamp_of(init)
        if stamp in have or now < init + timedelta(hours=WAIT_H) or now > init + timedelta(hours=24):
            continue
        if not available(init):
            continue
        process(init)
        cleanup()
        return "new", stamp, prev
    return "same", prev, prev


def cleanup():
    _cleanup(LAYER, "AIFS")


if __name__ == "__main__":
    import logging
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--init", help="指定起報 YYYYMMDDHH;不給就抓最新還沒抓的")
    a = ap.parse_args()
    if a.init:
        process(datetime.strptime(a.init, "%Y%m%d%H").replace(tzinfo=timezone.utc))
    else:
        print(run())
    r2.flush()

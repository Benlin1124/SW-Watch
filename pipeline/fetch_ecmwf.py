"""ECMWF IFS 0.1° 開放資料(台灣附近):氣壓、溫度、10 m 風、陣風、降雨、海浪;00/12Z 起報,0–168 小時(144 小時前每 3 小時、之後每 6 小時)。
參考 風雨變化趨勢_精簡版.ipynb。
  data/ecmwf/index.json              times = 起報時間(stamp);grid、vars、steps
  data/ecmwf/{起報}/{變數}.bin.gz    uint16 (步數, ny, nx),第 0 列最南;實際值 = raw * scale + offset,65535 = 無資料
變數:
  msl  海平面氣壓 hPa
  t2   2 m 溫度 °C
  u10 / v10  10 m 風 m/s(平均風 = 合成風速)
  gust 10 m 陣風 m/s:預報時刻前一段時間內最大:0–90 小時 = 前 1 小時(10fg)、93–144 小時 = 前 3 小時(10fg3)、
       150 小時起 = 前 6 小時(10fg);0–90 小時兩個時刻之間的極值抓不到
  tp   起報後累積雨量 mm(前端相減得到 3/6/12/24 小時雨量)
  swh  示性波高 m、mwd 平均波向(來向,度)、pp1d 尖峰週期 s、mwp 平均週期 s:海浪模式(stream wave,同網格;陸地 = 無資料)
下載:依 .index 用 HTTP Range 只抓需要的欄位(每欄全球 1–3.6 MB),解出後只留台灣附近。
  每報 53 步 ×(6 欄大氣 + 4 欄海浪)≈ 1.1 GB 下載;本機和 R2 每報只存約 6 MB。
  來源:AWS 鏡像(免費),失敗改 ECMWF 官網。
排程每 10 分鐘檢查一次:最新一報的 168 小時檔上架了就抓;重啟後會補保留期間內漏掉的報。
手動:python -m pipeline.fetch_ecmwf [--init 2026102200]"""
import argparse
import gzip
import json
import shutil
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import numpy as np
import requests

from . import config, r2
from .common import _atomic_write, grid_spec, layer_dir, log, quantize, read_index, remove, save_json, update_index

LAYER = "ecmwf"
HOSTS = ["https://ecmwf-forecasts.s3.eu-central-1.amazonaws.com", "https://data.ecmwf.int/forecasts"]
STEPS = list(range(0, min(config.ECMWF_MAX_STEP, 144) + 1, 3)) + list(range(150, config.ECMWF_MAX_STEP + 1, 6))
# 變數 → (ECMWF param, 換算, 量化 scale, offset, 單位, 名稱)
VARS = {
    "msl": ("msl", lambda v: v / 100, 0.1, 800.0, "hPa", "海平面氣壓"),
    "t2": ("2t", lambda v: v - 273.15, 0.01, -60.0, "°C", "2 m 溫度"),
    "u10": ("10u", None, 0.01, -300.0, "m/s", "10 m 東西風"),
    "v10": ("10v", None, 0.01, -300.0, "m/s", "10 m 南北風"),
    "gust": ("10fg", None, 0.01, 0.0, "m/s", "10 m 陣風(前 1 小時最大)"),
    "tp": ("tp", lambda v: v * 1000, 0.1, 0.0, "mm", "起報後累積雨量"),
    "swh": ("swh", None, 0.01, 0.0, "m", "示性波高"),
    "mwd": ("mwd", None, 0.01, 0.0, "°", "平均波向(來向)"),
    "pp1d": ("pp1d", None, 0.01, 0.0, "s", "尖峰週期"),
    "mwp": ("mwp", None, 0.01, 0.0, "s", "平均週期"),
}
WAVE = {"swh", "mwd", "pp1d", "mwp"}                # 這些在海浪模式的檔(stream wave),其餘在大氣(oper)
STREAMS = ("oper", "wave")
ALIAS = {"10fg": "10fg3"}                    # 93–144 小時的陣風叫 10fg3(前 3 小時最大)
GIVEN_UP_PATH = config.CACHE_DIR / "ecmwf_given_up.json"


def stamp_of(init):
    return init.strftime("%Y%m%d%H%M")


def _url(host, init, step, ext, stream="oper"):
    d, h = init.strftime("%Y%m%d"), init.strftime("%H")
    return (f"{host}/{d}/{h}z/ifs/{config.ECMWF_RESOL}/{stream}/"
            f"{d}{h}0000-{step}h-{stream}-fc-sfc.{ext}")


def _get(init, step, ext, headers=None, tries=6, stream="oper"):
    """依序試各來源;S3 忙碌(503 SlowDown)或連線失敗就等一下再試。404 直接回 None。"""
    last = None
    for k in range(tries):
        host = HOSTS[k % len(HOSTS)]
        try:
            r = requests.get(_url(host, init, step, ext, stream), headers=headers, timeout=120)
            if r.status_code == 404:
                return None
            if r.status_code in (200, 206):
                return r
            last = f"HTTP {r.status_code}"
        except requests.RequestException as e:
            last = f"{type(e).__name__}: {e}"
        time.sleep(min(5 * 2 ** k, 60))
    raise RuntimeError(f"ECMWF {stamp_of(init)} +{step}h {stream} {ext} 下載失敗:{last}")


def available(init):
    """大氣和海浪最後一步(84 小時)的 index 都上架了 → 這一報可以抓。"""
    def up(stream):
        for host in HOSTS:
            try:
                r = requests.head(_url(host, init, STEPS[-1], "index", stream), timeout=30)
                if r.status_code == 200:
                    return True
                if r.status_code == 404:
                    return False
            except requests.RequestException:
                continue
        return False
    return all(up(s) for s in STREAMS)


def _crop_slices(h):
    """全球規則經緯度網格 → 台灣附近的列、行(第 0 列在北)。"""
    import eccodes
    g = lambda k: eccodes.codes_get(h, k)
    ni, nj, d = g("Ni"), g("Nj"), g("iDirectionIncrementInDegrees")
    lat0, lon0 = g("latitudeOfFirstGridPointInDegrees"), g("longitudeOfFirstGridPointInDegrees")
    if g("jScansPositively") != 0:
        raise RuntimeError("ECMWF 格點不是由北往南排列")
    w, s, e, n = config.ECMWF_AREA
    r0, r1 = round((lat0 - n) / d), round((lat0 - s) / d)
    c0 = round(((w - lon0) % 360) / d)
    c1 = c0 + round((e - w) / d)
    if c1 >= ni:
        raise RuntimeError("台灣範圍跨越網格經度接縫")
    return ni, nj, slice(r0, r1 + 1), slice(c0, c1 + 1)


def _field(init, step, entry):
    """Range 下載一個 GRIB 欄位,解出後只留台灣附近(第 0 列在南);遮罩的格點(海浪的陸地)= NaN。"""
    import eccodes
    a, n = entry["_offset"], entry["_length"]
    r = _get(init, step, "grib2", headers={"Range": f"bytes={a}-{a + n - 1}"}, stream=entry["stream"])
    if r is None or len(r.content) != n:
        raise RuntimeError(f"ECMWF {stamp_of(init)} +{step}h {entry['param']} 下載不完整")
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
    """一個預報時刻的各變數(找不到的欄位回 None:0 小時沒有陣風、雨量)。"""
    entries = {}
    for stream in STREAMS:
        r = _get(init, step, "index", stream=stream)
        if r is None:
            raise RuntimeError(f"ECMWF {stamp_of(init)} +{step}h {stream} 尚未上架")
        for line in r.text.splitlines():
            e = json.loads(line)
            if e.get("levtype") == "sfc":
                e.setdefault("stream", stream)
                entries[e["param"]] = e
    jobs = {}
    for var, (param, *_rest) in VARS.items():
        e = entries.get(param) or entries.get(ALIAS.get(param))
        if e is not None and (e["stream"] == "wave") != (var in WAVE):
            e = None
        if e is None or e["_length"] < 1000:      # 0 小時的 tp / 10fg 只是空欄位
            continue
        jobs[var] = pool.submit(_field, init, step, e)
    out = {}
    for var, (_p, conv, *_rest) in VARS.items():
        v = jobs[var].result() if var in jobs else None
        out[var] = conv(v) if conv and v is not None else v
    return out


def grid_and_vars(shape):
    ny, nx = shape
    w, s, e, n = config.ECMWF_AREA
    d = 0.1 if config.ECMWF_RESOL == "0p1" else 0.25
    g = grid_spec(w, s, d, nx, ny, np.uint16, 1, 0, "")
    g.update(west=w - d / 2, east=e + d / 2, south=s - d / 2, north=n + d / 2)
    for k in ("scale", "offset", "units"):
        g.pop(k)
    vars_ = {k: dict(scale=sc, offset=off, units=u, name=name, dtype="uint16", nodata=65535)
             for k, (_p, _c, sc, off, u, name) in VARS.items()}
    return g, vars_


def process(init):
    """下載一報、存成每變數一個檔;任何一步失敗就整報放棄(下次排程再試)。"""
    t0 = time.time()
    log.info("ECMWF %s 開始下載(%d 步,約 1.1 GB、30–40 分鐘)", stamp_of(init), len(STEPS))
    data = {k: [] for k in VARS}
    with ThreadPoolExecutor(4) as pool:
        for step in STEPS:
            got = fetch_step(init, step, pool)
            for k in VARS:
                data[k].append(got[k])
    shape = next(v.shape for v in data["msl"] if v is not None)
    grid, vars_ = grid_and_vars(shape)
    stamp = stamp_of(init)
    out_dir = layer_dir(LAYER) / stamp
    for k, arrs in data.items():
        if k == "tp" and arrs[0] is None:
            arrs[0] = np.zeros(shape, np.float32)       # 起報時累積雨量 = 0
        stack = np.stack([a if a is not None else np.full(shape, np.nan, np.float32) for a in arrs])
        spec = dict(vars_[k], nodata=65535, dtype="uint16")
        raw = quantize(stack, spec)
        _atomic_write(out_dir / f"{k}.bin.gz", gzip.compress(raw.tobytes(), 6))
    update_index(LAYER, stamp, grid=grid, vars=vars_, steps=STEPS, nsteps=run_steps(LAYER, stamp, len(STEPS), grid),
                 name="ECMWF IFS 預報",
                 source=f"ECMWF open data IFS {config.ECMWF_RESOL}(CC BY 4.0)")
    log.info("ECMWF %s 完成:%d 步,%.0f 秒", stamp, len(STEPS), time.time() - t0)
    return stamp


def run_steps(layer, stamp, n, grid):
    """index 的 nsteps = 每報實際有幾步(預報長度改過時,舊報比 steps 短;網頁只顯示前 nsteps 步)。
    沒記錄的舊報看本機 msl.bin.gz 的大小。"""
    idx = read_index(layer)
    old = idx.get("nsteps", {})
    out = {}
    for t in idx["times"]:
        if t in old:
            out[t] = old[t]
            continue
        p = layer_dir(layer) / t / "msl.bin.gz"
        if p.exists():
            out[t] = len(gzip.decompress(p.read_bytes())) // (2 * grid["nx"] * grid["ny"])
    out[stamp] = n
    return out


def _given_up():
    return set(json.loads(GIVEN_UP_PATH.read_text(encoding="utf-8"))) if GIVEN_UP_PATH.exists() else set()


def _give_up(stamp):
    s = _given_up() | {stamp}
    GIVEN_UP_PATH.parent.mkdir(parents=True, exist_ok=True)
    GIVEN_UP_PATH.write_text(json.dumps(sorted(s)[-50:]), encoding="utf-8")


def candidates(now):
    """保留期間內的 00/12Z 起報,新的在前。"""
    t = now.replace(minute=0, second=0, microsecond=0)
    t -= timedelta(hours=t.hour % 12)
    out = []
    while t > now - timedelta(days=config.ECMWF_KEEP_DAYS):
        if t.hour in config.ECMWF_RUNS:
            out.append(t)
        t -= timedelta(hours=12)
    return out


def run(now=None):
    """還沒抓的報(新的優先)上架了就抓一報;太舊又抓不到的記為放棄。回傳 (狀態, 起報, 上一報)。"""
    now = now or datetime.now(timezone.utc)
    have = set(read_index(LAYER)["times"])
    prev = max(have) if have else None
    given_up = _given_up()
    for init in candidates(now):
        stamp = stamp_of(init)
        if stamp in have or stamp in given_up or now < init + timedelta(hours=config.ECMWF_WAIT_H):
            continue
        if not available(init):
            if now > init + timedelta(hours=24):
                log.warning("ECMWF %s 起報 24 小時後仍未上架,放棄", stamp)
                _give_up(stamp)
            continue
        process(init)
        cleanup()
        return "new", stamp, prev
    return "same", prev, prev


def cleanup(layer=LAYER, name="ECMWF"):
    """刪除超過保留天數的起報(本機與 R2);氣象署 WRF(fetch_wrf)同格式、同保留天數,也用這個。"""
    cutoff = stamp_of(datetime.now(timezone.utc) - timedelta(days=config.ECMWF_KEEP_DAYS))
    d = layer_dir(layer)
    idx = read_index(layer)
    drop = [t for t in idx["times"] if t < cutoff]
    for t in drop:
        for f in (d / t).glob("*"):
            remove(f)
        shutil.rmtree(d / t, ignore_errors=True)
    if drop:
        idx["times"] = [t for t in idx["times"] if t not in drop]
        idx["latest"] = idx["times"][-1] if idx["times"] else None
        idx["fetched"] = {t: v for t, v in idx.get("fetched", {}).items() if t not in drop}
        save_json(d / "index.json", idx)
        log.info("%s 清除 %d 報", name, len(drop))


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

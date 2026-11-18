"""CorrDiffTaiwan(NVIDIA earth2studio)降尺度:IFS、AIFS 0.25° 預報 → 台灣約 2 公里的最大回波、2 m 溫度、10 m 風。
獨立程式,不在排程裡(排程電腦可以沒有 GPU、也可以是樹莓派):誰有 GPU 誰跑,算完自己上傳 R2;停了不影響其他功能。
  data/corrdiff/{ifs|aifs}/index.json                  times = 起報;vars = 各變數格點規格;steps;nsteps[起報] = 已完成幾個時刻
  data/corrdiff/{ifs|aifs}/{起報}/{變數}_{時效:03d}.bin.gz   uint8,第 0 列最南;255 = 範圍外
輸入(0.25°,116–125.75°E、19.25–28°N):tcwv,500 / 850 hPa 的 z、t、u、v,2 m 溫度,10 m 風,直接向 ECMWF 開放資料抓。
  AIFS 沒有 tcwv → 用 tcw(以 IFS 驗證兩者 RMSE 0.29 kg/m2,平均約 36)。
輸出是 448×448 的曲線網格 → 最近鄰轉成 0.02° 經緯度格點。亂數種子由起報 + 時效決定,IFS、AIFS 用同一個。
模型是 ERA5 → WRF(2018–2021)訓練的,餵預報場超出訓練條件,是實驗產品。
安裝:python -m pipeline.corrdiff_setup(建 .venv-corrdiff、裝套件、下載模型)
執行:.venv-corrdiff 的 python -m pipeline.fetch_corrdiff --loop    持續跑(每 10 分鐘檢查新報)
      ... --bench    跑一個時刻量速度,不存檔;--init YYYYMMDDHHMM --model ifs 指定一報"""
import argparse
import gzip
import json
import os
import sys
import time
import types
import zlib
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import requests

from . import config, r2
from .common import _atomic_write, grid_spec, layer_dir, log, quantize, read_index, update_index
from .fetch_ecmwf import HOSTS, cleanup as _cleanup, stamp_of

LAYER = "corrdiff"
MODELS = {"ifs": "ifs", "aifs": "aifs-single"}     # 網頁代號 → 開放資料路徑
STEPS = list(range(0, 85, 6))
RUNS = (0, 12)
LOOKBACK = 3                                        # 往回看幾報(新的優先)
WAIT_H = 5                                          # 起報後幾小時才開始檢查
MODEL_DIR = Path(os.environ.get("CORRDIFF_MODEL_DIR", config.CACHE_DIR / "corrdiff"))
MODEL_ZIP = "corrdiff_inference_package.zip"
MODEL_URL = f"https://api.ngc.nvidia.com/v2/models/nvidia/modulus/corrdiff_inference_package/versions/1/files/{MODEL_ZIP}"

IN_LAT = np.linspace(19.25, 28, 36)
IN_LON = np.linspace(116, 126, 40, endpoint=False)
PL = [("z", 500), ("t", 500), ("u", 500), ("v", 500), ("z", 850), ("t", 850), ("u", 850), ("v", 850)]
SFC = ["2t", "10u", "10v"]
# 輸出格點(涵蓋模型網格的經緯度外框)
RES, W, S, NX, NY = 0.02, 116.12, 19.50, 474, 424
SPECS = {
    "mrr": grid_spec(W, S, RES, NX, NY, np.uint8, scale=0.5, offset=-32.0, units="dBZ"),
    "t2": grid_spec(W, S, RES, NX, NY, np.uint8, scale=0.25, offset=-20.0, units="°C"),
    "wind": grid_spec(W, S, RES, NX, NY, np.uint8, scale=0.25, offset=0.0, units="m/s"),
}
_regrid = None


# ── 輸入 ─────────────────────────────────────────────
def _base(model, init, step):
    d, h = init.strftime("%Y%m%d"), init.strftime("%H")
    return f"{d}/{h}z/{MODELS[model]}/0p25/oper/{d}{h}0000-{step}h-oper-fc"


def _get(path, headers=None, tries=8):
    last = None
    for k in range(tries):
        try:
            r = requests.get(f"{HOSTS[k % len(HOSTS)]}/{path}", headers=headers, timeout=120)
            if r.status_code in (200, 206):
                return r
            last = f"HTTP {r.status_code}"
        except requests.RequestException as e:
            last = f"{type(e).__name__}: {e}"
        time.sleep(min(3 * 2 ** k, 60))
    raise RuntimeError(f"{path} 下載失敗:{last}")


def available(model, init):
    """最後一個時刻上架了 → 這一報可以做。"""
    path = _base(model, init, STEPS[-1]) + ".index"
    for host in HOSTS:
        try:
            if requests.head(f"{host}/{path}", timeout=30).status_code == 200:
                return True
        except requests.RequestException:
            pass
    return False


def fetch_input(model, init, step, pool):
    """→ (12, 36, 40) float32,順序同 CorrDiffTaiwan 的輸入變數;第 0 列最南。"""
    import eccodes
    base = _base(model, init, step)
    idx = {}
    for line in _get(base + ".index").text.splitlines():
        e = json.loads(line)
        idx[(e["param"], int(e.get("levelist", 0)))] = e

    def download(key):
        e = idx[key]
        a, n = e["_offset"], e["_length"]
        return _get(base + ".grib2", {"Range": f"bytes={a}-{a + n - 1}"}).content

    def decode(msg):
        h = eccodes.codes_new_from_message(msg)
        try:
            g = lambda k: eccodes.codes_get(h, k)
            ni, nj, d = g("Ni"), g("Nj"), g("iDirectionIncrementInDegrees")
            lat0, lon0 = g("latitudeOfFirstGridPointInDegrees"), g("longitudeOfFirstGridPointInDegrees")
            v = eccodes.codes_get_values(h).reshape(nj, ni)
        finally:
            eccodes.codes_release(h)
        rows = np.rint((lat0 - IN_LAT) / d).astype(int)
        cols = np.rint(((IN_LON - lon0) % 360) / d).astype(int) % ni
        return v[rows][:, cols].astype(np.float32)

    water = ("tcwv", 0) if ("tcwv", 0) in idx else ("tcw", 0)
    keys = [water] + PL + [(p, 0) for p in SFC]
    # 下載可以平行;ecCodes 解碼不是執行緒安全(第一次讀定義檔時會整個程式崩潰)→ 一個一個解
    return np.stack([decode(m) for m in list(pool.map(download, keys))])


# ── 模型 ─────────────────────────────────────────────
def ensure_model():
    path = MODEL_DIR / MODEL_ZIP
    if not path.exists():
        MODEL_DIR.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".part")
        log.info("下載 CorrDiff 模型(約 0.72 GB)")
        with requests.get(MODEL_URL, stream=True, timeout=120) as r:
            r.raise_for_status()
            with open(tmp, "wb") as f:
                for b in r.iter_content(1 << 20):
                    f.write(b)
        os.replace(tmp, path)
    return MODEL_DIR


class Net:
    def __init__(self, device=None, steps=8):
        import torch
        try:
            import pygrib  # noqa: F401
        except ImportError:                        # Windows 編不了;CorrDiff 用不到,只是 earth2studio 匯入時要
            sys.modules["pygrib"] = types.ModuleType("pygrib")
        from earth2studio.models.auto import Package
        from earth2studio.models.dx import CorrDiffTaiwan
        self.torch = torch
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        # 用本機路徑:earth2studio 的 NGC 下載在 Windows 上路徑會錯
        self.model = CorrDiffTaiwan.load_model(Package(str(ensure_model())), device=self.device).eval()
        self.model.number_of_steps, self.model.number_of_samples = steps, 1
        self.coords = self.model.input_coords()
        self.coords["batch"] = np.array([0])
        self.lat, self.lon = self.model.out_lat.cpu().numpy(), self.model.out_lon.cpu().numpy()

    def __call__(self, x, seed):
        self.model.seed = seed
        t = self.torch.as_tensor(x[None], dtype=self.torch.float32, device=self.device)
        with self.torch.inference_mode():
            y, c = self.model(t, self.coords)
        y = y.cpu().numpy()[0, 0]
        return {str(v): y[i] for i, v in enumerate(c["variable"])}


def regrid_index(lat, lon):
    """輸出經緯度格點每格 → 模型網格最近的點;離模型網格太遠 = 範圍外。"""
    from scipy.spatial import cKDTree
    k = np.cos(np.radians(23.7))
    glon, glat = np.meshgrid(W + np.arange(NX) * RES, S + np.arange(NY) * RES)
    dist, i = cKDTree(np.c_[lon.ravel() * k, lat.ravel()]).query(np.c_[glon.ravel() * k, glat.ravel()], workers=-1)
    return i, dist > 0.025


def to_fields(out, lat, lon):
    """模型輸出(曲線網格)→ 各變數的經緯度格點(float,範圍外 NaN)。"""
    global _regrid
    if _regrid is None:
        _regrid = regrid_index(lat, lon)
    idx, outside = _regrid
    mrr = out["mrr"].astype(np.float32)
    mrr[mrr < 0] = -32                              # 負值 = 無回波(raw 0)
    fields = {"mrr": mrr, "t2": out["t2m"] - 273.15, "wind": np.hypot(out["u10m"], out["v10m"])}
    res = {}
    for k, a in fields.items():
        v = a.ravel()[idx].astype(np.float32)
        v[outside] = np.nan
        res[k] = v.reshape(NY, NX)
    return res


# ── 主流程 ───────────────────────────────────────────
def step_path(model, stamp, var, step):
    return layer_dir(f"{LAYER}/{model}") / stamp / f"{var}_{step:03d}.bin.gz"


def done_steps(model, stamp):
    """從頭連續完成了幾個時刻(wind 最後寫,有它就代表這個時刻完整)。"""
    n = 0
    for s in STEPS:
        if not step_path(model, stamp, "wind", s).exists():
            break
        n += 1
    return n


def process(net, model, init, pool):
    stamp, layer = stamp_of(init), f"{LAYER}/{model}"
    first = done_steps(model, stamp)
    log.info("CorrDiff %s %s 開始:時刻 %d/%d,裝置 %s", model, stamp, first, len(STEPS), net.device)
    for n, step in enumerate(STEPS[first:], first + 1):
        t0 = time.time()
        x = fetch_input(model, init, step, pool)
        t1 = time.time()
        res = to_fields(net(x, zlib.crc32(f"{stamp}{step}".encode())), net.lat, net.lon)
        for var, spec in SPECS.items():                   # 順序:wind 最後
            _atomic_write(step_path(model, stamp, var, step), gzip.compress(quantize(res[var], spec).tobytes(), 6))
        nsteps = read_index(layer).get("nsteps", {})
        nsteps[stamp] = n
        update_index(layer, stamp, source=f"CorrDiffTaiwan + {model.upper()}", vars=SPECS, steps=STEPS, nsteps=nsteps)
        r2.flush()
        log.info("CorrDiff %s %s +%dh 完成:下載 %.0f 秒、推論 %.0f 秒", model, stamp, step, t1 - t0, time.time() - t1)


def candidates(now=None):
    now = (now or datetime.now(timezone.utc)) - timedelta(hours=WAIT_H)
    t = now.replace(hour=now.hour - now.hour % 12, minute=0, second=0, microsecond=0)
    return [t - timedelta(hours=12 * k) for k in range(LOOKBACK)]


def run_once(net_factory, models=tuple(MODELS)):
    """做最新一報還沒完成的;做完一組就回 True(再從最新的看起)。"""
    for init in candidates():
        for model in models:
            if done_steps(model, stamp_of(init)) < len(STEPS) and available(model, init):
                with ThreadPoolExecutor(4) as pool:
                    process(net_factory(), model, init, pool)
                return True
    return False


def cleanup():
    for m in MODELS:
        _cleanup(f"{LAYER}/{m}", f"CorrDiff {m}")
    r2.flush()


def bench(net, pool):
    """跑一個時刻量速度(不存檔)。"""
    init = next(t for t in candidates() if available("ifs", t))
    x = fetch_input("ifs", init, 24, pool)
    if net.device == "cuda":
        net.torch.cuda.reset_peak_memory_stats()
    t0 = time.time()
    y = net(x, 1)
    sec = time.time() - t0
    n = len(STEPS) * len(MODELS)
    print(f"裝置 {net.device}:一個時刻 {sec:.0f} 秒;每報 {n} 個時刻約 {sec * n / 3600:.1f} 小時,一天兩報約 {sec * n * 2 / 3600:.1f} 小時")
    if net.device == "cuda":
        print(f"GPU 記憶體峰值 {net.torch.cuda.max_memory_allocated() / 1e9:.1f} GB")
    for k, v in y.items():
        print(f"  {k}: {v.min():.1f} ~ {v.max():.1f}")


def main():
    import logging
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--loop", action="store_true", help="持續跑,每 10 分鐘檢查新報")
    ap.add_argument("--bench", action="store_true", help="跑一個時刻量速度,不存檔")
    ap.add_argument("--init", help="指定起報 YYYYMMDDHHMM")
    ap.add_argument("--model", choices=list(MODELS), help="只做這個模式")
    ap.add_argument("--device", help="cuda / cpu;預設有 GPU 就用")
    a = ap.parse_args()
    try:
        import psutil
        p = psutil.Process()
        p.nice(psutil.BELOW_NORMAL_PRIORITY_CLASS if os.name == "nt" else 10)   # 不和即時工作搶 CPU
    except ImportError:
        pass
    net = None

    def get_net():
        nonlocal net
        net = net or Net(a.device)
        return net

    models = (a.model,) if a.model else tuple(MODELS)
    if a.bench:
        with ThreadPoolExecutor(4) as pool:
            bench(get_net(), pool)
    elif a.init:
        init = datetime.strptime(a.init, "%Y%m%d%H%M").replace(tzinfo=timezone.utc)
        with ThreadPoolExecutor(4) as pool:
            for m in models:
                process(get_net(), m, init, pool)
    else:
        while True:
            try:
                busy = run_once(get_net, models)
                cleanup()
            except Exception:
                log.exception("CorrDiff 失敗,稍後重試")
                busy = False
            if not a.loop:
                break
            if not busy:
                time.sleep(600)


if __name__ == "__main__":
    main()

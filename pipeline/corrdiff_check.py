"""檢查 CorrDiff 輸出的位置偏移(不存檔、不上傳;GPU 約一兩分鐘,大部分是下載 IFS):
  .venv-corrdiff 的 python -m pipeline.corrdiff_check
三組都和模型包裡的 WRF 真值(同一個 448×448 網格)比,數字是「輸出相對真值」的位移(格,約 2 公里;+ = 往東、往北):
  A 訓練用 ERA5 → 模型(5 個時間,和同時間真值比):模型本身有沒有偏
  B IFS 照現在的流程(預報時間和真值不同,只比地形造成的固定分布)
  C IFS,輸入內插時先移動取樣位置:輸入移回來,輸出會不會跟著回來
只看 2 m 溫度、10 m 風速的小尺度分布(高通後互相關);相關 < 0.3 的不可靠。"""
import argparse
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from scipy.ndimage import gaussian_filter

from . import fetch_corrdiff as F

ZARR = "corrdiff_inference_package/dataset/2023-01-24-cwb-4years_5times.zarr"
IN_IDX = [0, 1, 2, 3, 4, 9, 10, 11, 12, 17, 18, 19]        # era5 → CorrDiffTaiwan 的 12 個輸入
OUT_IDX = {"mrr": 0, "t2m": 17, "u10m": 18, "v10m": 19}    # cwb → 輸出
REGIONS = {"全島": (119.9, 122.1, 21.8, 25.4), "北部": (120.8, 122.1, 24.3, 25.4),
           "中部": (120.3, 121.8, 23.3, 24.4), "南部": (120.3, 121.3, 21.9, 23.3)}
IFS_STEPS = (0, 12, 24, 36)
INPUT_SHIFTS = ((0.0, 0.0), (1.8, 1.5), (3.0, 2.0))         # C 組:輸入取樣往東、往北移幾格
MAX_SHIFT = 12


def crop(a):
    return a[..., 1:-1, 1:-1]


def fields(y):
    """輸出 / 真值的 dict → 要比的兩個量"""
    return {"溫度": y["t2m"], "風速": np.hypot(y["u10m"], y["v10m"])}


def box(lat, lon, b):
    w, e, s, n = b
    j, i = np.where((lat >= s) & (lat <= n) & (lon >= w) & (lon <= e))
    return j.min(), j.max() + 1, i.min(), i.max() + 1


def prep(a, r):
    h = a - gaussian_filter(a, 12, mode="nearest")
    j0, j1, i0, i1 = r
    h = h[j0:j1, i0:i1]
    return (h - h.mean()) * np.outer(np.hanning(j1 - j0), np.hanning(i1 - i0))


def shift(pairs, r):
    """[(輸出, 真值)...] 的互相關加總 → (東, 北, 相關)"""
    total, ea, eb = 0, 0, 0
    for a, b in pairs:
        p, q = prep(a, r), prep(b, r)
        total = total + np.fft.fftshift(np.fft.irfft2(np.fft.rfft2(p) * np.conj(np.fft.rfft2(q)), p.shape))
        ea += (p ** 2).sum()
        eb += (q ** 2).sum()
    cy, cx = total.shape[0] // 2, total.shape[1] // 2
    m = min(MAX_SHIFT, cy - 1, cx - 1)
    w = total[cy - m:cy + m + 1, cx - m:cx + m + 1]
    j, i = np.unravel_index(w.argmax(), w.shape)
    cc = w.max() / np.sqrt(ea * eb)
    if not (0 < i < 2 * m and 0 < j < 2 * m):
        return np.nan, np.nan, cc
    sub = lambda l, c, n: 0.5 * (l - n) / (l - 2 * c + n)
    return i - m + sub(w[j, i - 1], w[j, i], w[j, i + 1]), j - m + sub(w[j - 1, i], w[j, i], w[j + 1, i]), cc


def report(title, cases, lat, lon):
    """cases:量 → [(輸出, 真值)...]"""
    print(f"\n{title}")
    for name, pairs in cases.items():
        cells = []
        for reg, b in REGIONS.items():
            e, n, c = shift(pairs, box(lat, lon, b))
            cells.append(f"{reg} 東{e:+.1f} 北{n:+.1f} (相關{c:.2f})")
        print(f"  {name}:" + "  ".join(cells))


def infer(net, x):
    """x (12, H, W) → 各輸出(numpy,單位同模型輸出)"""
    t = net.torch.as_tensor(x, dtype=net.torch.float32, device=net.device)
    y = net.model._forward(t).cpu().numpy()[0]
    return {k: y[i] for i, k in enumerate(("mrr", "t2m", "u10m", "v10m"))}


def run(net, root, ifs_inputs):
    m = net.model
    lat, lon = crop(root["XLAT"][:]), crop(root["XLONG"][:])
    cwb, era = root["cwb"], root["era5"]
    truth = [{k: crop(cwb[t][i]) for k, i in OUT_IDX.items()} for t in range(cwb.shape[0])]
    truth_f = [fields(t) for t in truth]
    truth_mean = {k: np.mean([t[k] for t in truth_f], 0) for k in truth_f[0]}
    interpolate = m._interpolate

    # A:訓練用 ERA5(已在同一網格上,不經內插)
    m._interpolate = lambda x: x
    out = []
    for t in range(era.shape[0]):
        m.seed = t + 1
        out.append(fields(infer(net, crop(era[t][IN_IDX]))))
    m._interpolate = interpolate
    report("A 訓練用 ERA5 → 模型,和同時間 WRF 比", {k: [(o[k], w[k]) for o, w in zip(out, truth_f)] for k in truth_mean}, lat, lon)

    # B、C:IFS,輸入內插時移動取樣位置
    lat_full, lon_full = m.out_lat_full, m.out_lon_full
    la, lo = lat_full.cpu().numpy(), lon_full.cpu().numpy()
    dla_j, dla_i = np.gradient(la)
    dlo_j, dlo_i = np.gradient(lo)
    tensor = lambda a: net.torch.as_tensor(a, dtype=lat_full.dtype, device=lat_full.device)
    for dx, dy in INPUT_SHIFTS:
        m.out_lat_full = tensor(la + dx * dla_i + dy * dla_j)
        m.out_lon_full = tensor(lo + dx * dlo_i + dy * dlo_j)
        got = []
        for k, x in enumerate(ifs_inputs):
            m.seed = k + 1
            got.append(fields(infer(net, x)))
        mean = {k: np.mean([g[k] for g in got], 0) for k in truth_mean}
        tag = "B IFS 現在的流程" if dx == dy == 0 else f"C IFS,輸入取樣移東 {dx} 北 {dy} 格"
        report(f"{tag}(只比地形分布)", {k: [(mean[k], truth_mean[k])] for k in truth_mean}, lat, lon)
    m.out_lat_full, m.out_lon_full = lat_full, lon_full


def main():
    import zarr
    ap = argparse.ArgumentParser()
    ap.add_argument("--device", help="cuda / cpu;預設有 GPU 就用")
    a = ap.parse_args()
    net = F.Net(a.device)                                   # 第一次載入時會解開模型包
    root = zarr.open_group(str(F.MODEL_DIR / ZARR), mode="r")
    init = next(t for t in F.candidates() if F.available("ifs", t))
    print(f"裝置 {net.device};IFS {F.stamp_of(init)} +{list(IFS_STEPS)} 小時")
    with ThreadPoolExecutor(4) as pool:
        inputs = [F.fetch_input("ifs", init, s, pool) for s in IFS_STEPS]
    run(net, root, inputs)


if __name__ == "__main__":
    main()

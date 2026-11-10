"""氣象署降雨雷達(O-A0084-001 樹林、-002 南屯、-003 林園):單雷達合成回波圖 → 依色標還原 dBZ → 經緯度格點。
  data/rainradar/{站}/index.json、{stamp}.bin.gz   格式同 data/radar(uint8,0.5 dBZ 一階,0 = 無回波,255 = 範圍外)
來源:cwaopendata S3 公開網址 Observation/O-A0084-00N.json(1 KB,DateTime = 資料時間)與 .png(3600×3600,約 1 MB),
  不計會員次數。json 的時間比已抓的新才下載圖。約每 2 分鐘一張。
保存:時間軸一格 10 分鐘 → 每格只留第一張(歷史,保留 KEEP_DAYS 天);另外留最新一張(index 的 transient),
  同一格再來新圖就換掉它(刪舊檔)→ 停在最新時看得到 2 分鐘前的回波,存量不會變 5 倍。
圖的格式(2026-11 實測):
  - 以雷達為中心的方位等距投影,每公里 11.974 px(三站用底圖海岸線擬合一致),畫到距雷達 150 公里;
    json 的站點經緯度只到 0.01°,圖心各站另外擬合(CENTER,px)。
  - 色標 0–65 dBZ 每 1 dBZ 一色(PALETTE,取自圖右下色條,和氣象署回波色階相同)。回波邊緣有反鋸齒混色 → 取最接近的色標色,
    距離太遠的不算回波。
  - 底色:白 / 淺灰(陸地)= 範圍內無回波;藍灰(圓外、被遮蔽的扇形)= 範圍外。
    海岸線、縣市界、距離圈、文字等線條 → 用最近的非線條像素補(回波裡的界線不會留洞)。
網格:0.002°(約 200 m),範圍 = 雷達 ±150 公里的經緯度外框;圓外 = 範圍外。
手動:python -m pipeline.fetch_rainradar"""
import io
import time

import numpy as np
import requests

from .common import _io_lock, grid_spec, layer_dir, log, read_index, remove, save_grid, save_json, utc_stamp

LAYER = "rainradar"
S3 = "https://cwaopendata.s3.ap-northeast-1.amazonaws.com/Observation"
# 站 → (資料代號, 名稱, 圖心 px (x, y))
SITES = {
    "shulin": ("O-A0084-001", "樹林", (1799.84, 1800.97)),
    "nantun": ("O-A0084-002", "南屯", (1799.99, 1800.52)),
    "linyuan": ("O-A0084-003", "林園", (1800.00, 1798.97)),
}
PX_KM = 11.974
RANGE_KM = 150.0
RES = 0.002
MAX_DIST = 60            # 和最接近的色標色 RGB 距離超過這個就不算回波
# 0–65 dBZ(索引 = dBZ)
PALETTE = np.array([
    (0, 255, 255), (0, 236, 255), (0, 218, 255), (0, 200, 255), (0, 182, 255), (0, 163, 255), (0, 145, 255),
    (0, 127, 255), (0, 109, 255), (0, 91, 255), (0, 72, 255), (0, 54, 255), (0, 36, 255), (0, 18, 255),
    (0, 0, 255), (0, 255, 0), (0, 244, 0), (0, 233, 0), (0, 222, 0), (0, 211, 0), (0, 200, 0), (0, 190, 0),
    (0, 180, 0), (0, 170, 0), (0, 160, 0), (0, 150, 0), (51, 171, 0), (102, 192, 0), (153, 213, 0),
    (204, 234, 0), (255, 255, 0), (255, 244, 0), (255, 233, 0), (255, 222, 0), (255, 211, 0), (255, 200, 0),
    (255, 184, 0), (255, 168, 0), (255, 152, 0), (255, 136, 0), (255, 120, 0), (255, 96, 0), (255, 72, 0),
    (255, 48, 0), (255, 24, 0), (255, 0, 0), (244, 0, 0), (233, 0, 0), (222, 0, 0), (211, 0, 0), (200, 0, 0),
    (190, 0, 0), (180, 0, 0), (170, 0, 0), (160, 0, 0), (150, 0, 0), (171, 0, 51), (192, 0, 102),
    (213, 0, 153), (234, 0, 204), (255, 0, 255), (234, 0, 255), (213, 0, 255), (192, 0, 255), (171, 0, 255),
    (150, 0, 255)], np.int32)
NO_ECHO, OUTSIDE, LINE = -1, -2, -3
session = requests.Session()
_maps = {}               # 站 → (格點規格, 每格對應的像素索引, 圓外遮罩)


def _get(url, timeout=60):
    r = session.get(url, timeout=timeout)
    r.raise_for_status()
    return r


def classify(rgb, band=600):
    """(H, W, 3) uint8 → (H, W) int16:0–65 = dBZ,NO_ECHO、OUTSIDE、LINE(線條 / 文字,之後由 sample 補)。
    每次處理 band 列,省記憶體。"""
    return np.concatenate([_classify(rgb[y:y + band]) for y in range(0, rgb.shape[0], band)])


def _classify(rgb):
    a = rgb.astype(np.int16)
    r, b = a[..., 0], a[..., 2]
    out = np.full(r.shape, LINE, np.int16)
    hi, lo = a.max(2), a.min(2)
    out[(lo >= 200) & (b - r < 5)] = NO_ECHO               # 白、淺灰:範圍內無回波
    out[(lo >= 190) & (b - r >= 5)] = OUTSIDE              # 藍灰:範圍外
    cand = np.flatnonzero(hi - lo >= 40)                    # 有彩度的才可能是回波
    if cand.size:
        px = a.reshape(-1, 3)[cand].astype(np.int32)
        best = np.empty(cand.size, np.int16)
        dist = np.empty(cand.size, np.int32)
        for s in range(0, cand.size, 100_000):              # 分段算,避免一次吃掉太多記憶體
            d = ((px[s:s + 100_000, None, :] - PALETTE[None]) ** 2).sum(2)
            best[s:s + 100_000] = d.argmin(1)
            dist[s:s + 100_000] = d.min(1)
        ok = dist <= MAX_DIST ** 2
        out.reshape(-1)[cand[ok]] = best[ok]
    return out


def sample(cls, py, px, reach=6):
    """取格點對應像素的類別;落在線條上的,往外一圈圈找最近的非線條像素(回波裡的界線不留洞)。"""
    h, w = cls.shape
    v = cls[py, px]
    todo = np.flatnonzero(v == LINE)
    for r in range(1, reach + 1):
        if not todo.size:
            break
        ring = [(dy, dx) for dy in range(-r, r + 1) for dx in range(-r, r + 1) if max(abs(dy), abs(dx)) == r]
        ring.sort(key=lambda d: d[0] ** 2 + d[1] ** 2)
        for dy, dx in ring:
            c = cls[np.clip(py[todo] + dy, 0, h - 1), np.clip(px[todo] + dx, 0, w - 1)]
            hit = c != LINE
            v[todo[hit]] = c[hit]
            todo = todo[~hit]
            if not todo.size:
                break
    v[todo] = NO_ECHO                                        # 大片文字等:當無回波
    return v


def site_map(site, lon0, lat0, shape):
    """站的經緯度格點,和每格對應的圖像素(方位等距反算);第一次算好留著。
    圓外、雷達位置記號(圖心藍點,半徑約 1 公里)另外標出。"""
    key = (site, lon0, lat0, shape)
    if key not in _maps:
        from pyproj import Proj
        cx, cy = SITES[site][2]
        h, w = shape
        half_lat = RANGE_KM / 111.195
        half_lon = RANGE_KM / (111.195 * np.cos(np.radians(lat0 + half_lat)))   # 北緣最寬
        s = round((lat0 - half_lat) / RES) * RES
        wl = round((lon0 - half_lon) / RES) * RES
        ny = int(round(2 * half_lat / RES)) + 1
        nx = int(round(2 * half_lon / RES)) + 1
        lon, lat = np.meshgrid(wl + np.arange(nx) * RES, s + np.arange(ny) * RES)
        x, y = Proj(proj="aeqd", lon_0=lon0, lat_0=lat0, R=6371000)(lon, lat)
        r = np.hypot(x, y)
        out, mark = r > RANGE_KM * 1000, r < 1000
        px = np.clip(np.rint(cx + x / 1000 * PX_KM), 0, w - 1).astype(np.int32)
        py = np.clip(np.rint(cy - y / 1000 * PX_KM), 0, h - 1).astype(np.int32)
        spec = grid_spec(round(wl, 3), round(s, 3), RES, nx, ny, np.uint8, scale=0.5, offset=-32.0, units="dBZ")
        _maps[key] = (spec, py.ravel(), px.ravel(), out.ravel(), mark.ravel())
    return _maps[key]


def process(site, info, png):
    from PIL import Image
    p = info["dataset"]["datasetInfo"]["parameterSet"]
    lon0, lat0 = float(p["StationLongitude"]), float(p["StationLatitude"])
    rgb = np.asarray(Image.open(io.BytesIO(png)).convert("RGB"))
    cls = classify(rgb)
    spec, py, px, out, mark = site_map(site, lon0, lat0, cls.shape)
    v = sample(cls, py, px)
    v[mark] = NO_ECHO
    arr = np.where(v >= 0, v, -32).astype(np.float32)      # 無回波 → raw 0
    arr[(v == OUTSIDE) | out] = np.nan                      # 範圍外 → nodata
    return arr.reshape(spec["ny"], spec["nx"]), spec


def run_site(site):
    code, name, _c = SITES[site]
    layer = f"{LAYER}/{site}"
    info = _get(f"{S3}/{code}.json").json()["cwaopendata"]
    stamp = utc_stamp(info["dataset"]["DateTime"])
    idx = read_index(layer)
    prev = idx["times"][-1] if idx["times"] else None
    if prev and stamp <= prev:
        return ("same" if stamp == prev else "older"), stamp, prev
    t0 = time.time()
    png = _get(f"{S3}/{code}.png").content
    arr, spec = process(site, info, png)
    old = idx.get("transient")
    keep = {t[:11] for t in idx["times"] if t != old}           # 已留歷史的 10 分鐘格(stamp 前 11 碼)
    save_grid(layer, stamp, arr, spec, source=f"CWA {code}", name=f"降雨雷達 {name}",
              transient=stamp if stamp[:11] in keep else None)
    if old:
        drop_transient(layer, old)
    log.info("降雨雷達 %s %s 完成:%.0f 秒,%d 格有回波", name, stamp, time.time() - t0, int((arr > -32).sum()))
    return "new", stamp, prev


def drop_transient(layer, stamp):
    """刪掉上一張「最新」(它那一格已經有歷史那張)。"""
    remove(layer_dir(layer) / f"{stamp}.bin.gz")
    with _io_lock:
        idx = read_index(layer)
        idx["times"] = [t for t in idx["times"] if t != stamp]
        idx.get("fetched", {}).pop(stamp, None)
        save_json(layer_dir(layer) / "index.json", idx)


def run():
    """三站各自檢查;回傳 (狀態, 資料時間, 上一筆):任一站有新資料 = new(時間取最新那站)。"""
    res, errors = [], []
    for site in SITES:
        try:
            res.append(run_site(site))
        except Exception as e:
            log.exception("降雨雷達 %s 失敗", SITES[site][1])
            errors.append(f"{SITES[site][1]} {type(e).__name__}: {e}")
    if errors and not res:
        raise RuntimeError(";".join(errors))
    new = [r for r in res if r[0] == "new"]
    return max(new or res, key=lambda r: r[1] or "")


if __name__ == "__main__":
    import logging
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    print(run())

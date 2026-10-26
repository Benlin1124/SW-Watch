"""真實色雲圖(日夜合成,satellite/TC):
白天:B03 紅 / B02 混 15% B04 綠 / B01 藍,反照率先除以 cos(太陽天頂角)(天頂角 80° 以上不再放大,約 5.8 倍),
     再減 Rayleigh 散射(pyspectral;天頂角 70→88° 逐漸減弱,避免晨昏過度修正變橘);
     暗部拉亮曲線 → 局部對比(半徑 20 反銳化)→ 細部銳化(半徑 2)。
夜間:同網頁「日夜」頻道的紅外線灰階(B07,冷雲頂 −30→−50 °C 漸變改用 B13)。
太陽仰角 0→10° 之間白天 / 夜間線性漸變。網頁「日夜」頻道直接把這張圖轉灰階顯示。
格點同 fetch_satellite.target(Web Mercator 等間距),影像第 0 列在北(圖片方向)。"""
import numpy as np
from PIL import Image, ImageFilter

DN_NIGHT, DN_DAY = 0.0, 10.0                     # 太陽仰角 ≤ 0° 全夜間、≥ 10° 全白天
B07_GRAY = [(30, 0), (20, 0.18), (10, 0.38), (0, 0.55), (-20, 0.7), (-50, 0.85), (-80, 1)]   # 同網頁 colormaps.js
DN_COLD = (-30.0, -50.0)                         # 夜間冷雲頂改用 B13(避開 B07 低溫雜訊)
CURVE = ([0, 5, 10, 20, 40, 70, 100], [0, 45, 75, 110, 160, 215, 255])   # 反照率 % → 亮度(暗部拉亮、亮部保斜率)
SUNZ_MAX = 80.0                                  # 天頂角補償上限
RAY_FULL, RAY_ZERO = 70.0, 88.0                  # Rayleigh 修正從 70° 開始減弱、88° 歸零
GREEN_NIR = 0.15                                 # 混綠:B02 × 0.85 + B04 × 0.15
BLOCK = 300                                      # 角度、Rayleigh 分塊算(整張 0.01° 一次算要好幾 GB)
SAT_LON = 140.7                                  # Himawari-9 星下點經度

_ray = None


def rayleigh():
    global _ray
    if _ray is None:
        from pyspectral.rayleigh import Rayleigh
        _ray = Rayleigh("Himawari-9", "ahi", atmosphere="us-standard", aerosol_type="rayleigh_only")
    return _ray


def angles(when, lon, lat):
    """→ 太陽天頂角、衛星天頂角、太陽與衛星方位角差(度);lon / lat 為 2D。"""
    from pyorbital import astronomy
    from pyorbital.orbital import get_observer_look
    sunz = astronomy.sun_zenith_angle(when, lon, lat)
    sun_az = np.degrees(astronomy.get_alt_az(when, lon, lat)[1])
    sat_az, sat_el = get_observer_look(np.array([SAT_LON]), np.array([0.0]), np.array([35786.0]), when,
                                       lon, lat, np.zeros_like(lon))
    return sunz, 90 - sat_el, np.abs(((sun_az - sat_az) + 180) % 360 - 180)


def night_gray(t07, t13):
    """夜間灰階 0–255 uint8(缺值 0);t07 / t13 為亮溫 °C(B13 缺就只用 B07,B07 缺就用 B13)。分塊算省記憶體。"""
    xs, gs = zip(*B07_GRAY[::-1])
    out = np.zeros(t07.shape, np.uint8)
    for i in range(0, t07.shape[0], BLOCK):
        a, b = t07[i:i + BLOCK], t13[i:i + BLOCK]
        c = np.clip((DN_COLD[0] - b) / (DN_COLD[0] - DN_COLD[1]), 0, 1)
        c = np.where(np.isnan(b), 0, np.where(np.isnan(a), 1, c))
        t = np.where(c == 0, a, np.where(c == 1, b, (1 - c) * a + c * b))
        out[i:i + BLOCK] = np.round(np.interp(np.nan_to_num(t), xs, gs) * 255).clip(0, 255)
    return out


def day_rgb(refl, when, lon, lat):
    """refl:{B01..B04: 反照率 % (ny, nx)};lon 1D、lat 1D(列順序同 refl)。
    → (RGB uint8 已套曲線、局部對比與銳化, 太陽仰角 float32)。"""
    ny, nx = refl["B03"].shape
    img = np.zeros((ny, nx, 3), np.uint8)          # 每塊算完直接套曲線存 uint8(整張 float 要 200 MB)
    el = np.zeros((ny, nx), np.float32)
    ray = rayleigh()
    for i in range(0, ny, BLOCK):
        sl = slice(i, min(i + BLOCK, ny))
        LON, LAT = np.meshgrid(lon, lat[sl])
        sunz, satz, azd = angles(when, LON, LAT)
        el[sl] = 90 - sunz
        cosz = np.cos(np.radians(np.minimum(sunz, SUNZ_MAX)))
        fray = np.clip((RAY_ZERO - sunz) / (RAY_ZERO - RAY_FULL), 0, 1)
        ch = {}
        for b in ("B01", "B02", "B03", "B04"):
            r = np.nan_to_num(refl[b][sl])
            rc = np.asarray(ray.get_reflectance(sunz, satz, azd, b, redband=np.nan_to_num(refl["B03"][sl])),
                            dtype=np.float32)
            ch[b] = r / cosz - np.nan_to_num(rc) * fray
        for k, v in enumerate((ch["B03"], (1 - GREEN_NIR) * ch["B02"] + GREEN_NIR * ch["B04"], ch["B01"])):
            img[sl, :, k] = np.interp(np.clip(v, 0, 100), *CURVE)
        del ch, sunz, satz, azd, LON, LAT
    im = Image.fromarray(img).filter(ImageFilter.UnsharpMask(radius=20, percent=60, threshold=0))
    del img
    im = im.filter(ImageFilter.UnsharpMask(radius=2, percent=60, threshold=2))
    return np.asarray(im), el


def compose(night, day=None):
    """night:夜間灰階 uint8 (ny, nx)(第 0 列在北);day:(RGB uint8, 太陽仰角) 或 None(整張夜間)。→ PIL RGB。"""
    if day is None:
        return Image.fromarray(night).convert("RGB")
    rgb, el = day
    out = np.empty(rgb.shape, np.uint8)
    for i in range(0, rgb.shape[0], BLOCK):
        sl = slice(i, i + BLOCK)
        w = np.clip((el[sl] - DN_NIGHT) / (DN_DAY - DN_NIGHT), 0, 1)[..., None]
        out[sl] = np.round(rgb[sl] * w + night[sl, :, None] * (1 - w)).clip(0, 255)
    return Image.fromarray(out)

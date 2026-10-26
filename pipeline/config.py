"""平台設定:路徑、金鑰、各圖層格點規格。金鑰一律從環境變數 / .env 讀,不寫進程式。"""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
CACHE_DIR = ROOT / "pipeline" / ".cache"
LOG_DIR = ROOT / "logs"


def _load_dotenv(path=ROOT / ".env"):
    """極簡 .env 讀取(KEY=VALUE),不另外裝套件。已存在的環境變數優先。"""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_dotenv()
CWA_KEY = os.environ.get("CWA_KEY", "")

CWA_FILEAPI = ("https://opendata.cwa.gov.tw/fileapi/v1/opendataapi/{code}"
               "?Authorization={key}&downloadType=WEB&format=JSON")
CWA_REST = "https://opendata.cwa.gov.tw/api/v1/rest/datastore/{code}"   # 授權碼用 params 帶

# TWD67 大地基準(GRS67 橢球 = aust_SA)+ 七參數 Helmert 轉 WGS84(同 EPSG:3828 的 towgs84 定義)。
# 以 O-A0002-001 各站官方 TWD67/WGS84 雙座標驗證:差距中位數 2 m。
# 註:pyproj 內建 EPSG:3821→4326 只有 ballpark 轉換(等於不轉,誤差約 850 m),不能用。
TWD67_PROJ = ("+proj=longlat +ellps=aust_SA "
              "+towgs84=-752,-358,-179,-0.0000011698,0.0000018398,0.0000009822,0.00002329 +no_defs")

# ── CWA 抓取 ──
# 會員 API 上限:24 小時 2 萬次、每日 2 GB。fileapi 只用來解析 S3 轉址,TTL 內不重複呼叫。
CWA_RESOLVE_TTL_SEC = 6 * 3600

# ── 保留策略 ──
KEEP_DAYS = int(os.environ.get("KEEP_DAYS", 10))   # 測站、雷達、雨量等資料保留天數,更舊的全刪(要永久保留用 event_archive);.env 可改

# ── 自製 IDW 雨量格點 ──
IDW_EXTENT = (118.0, 21.8, 122.2, 26.4)   # lon_min, lat_min, lon_max, lat_max
IDW_RES = 0.01
IDW_K = 8
IDW_POWER = 2.0
IDW_RADIUS_KM = 25.0

# 測站雨量欄位 → 平台累積時間代碼
RAIN_ACC = {
    "10m": "Past10Min",
    "1h": "Past1hr",
    "3h": "Past3hr",
    "6h": "Past6hr",
    "12h": "Past12hr",
    "24h": "Past24hr",
    "48h": "Past2days",
    "72h": "Past3days",
    "today": "Now",
}

TAIWAN_GEOJSON_URL = "https://watch.ncdr.nat.gov.tw/00_Wxmap/json/area/low/TWN_CITY_low.json"

# ── 衛星(Himawari-9,AWS noaa-himawari9 全盤 HSD)──
SAT_BUCKET = "noaa-himawari9/AHI-L1b-FLDK"
SAT_EXTENT = (105.0, 5.0, 155.0, 35.0)     # lon_min, lat_min, lon_max, lat_max
# 紅外線頻道(各自處理、24 小時)→ (輸出解析度 °, 校正方式, 量化 scale, offset, 單位)
SAT_BANDS = {
    "B13": (0.02, "brightness_temperature", 0.6, -100.0, "°C"),
    "B07": (0.02, "brightness_temperature", 0.6, -90.0, "°C"),    # 3.9 µm 短波紅外:夜間低雲、霧(白天含太陽反射,地表可到 50 °C 以上)
    "B08": (0.02, "brightness_temperature", 0.6, -100.0, "°C"),
}
# 可見光(白天,和真實色一起處理,見 fetch_satellite.process_tc / truecolor.py):
#   下載 B01 藍、B02 綠、B03 紅、B04 近紅外 → 0.01° 真實色 WebP(satellite/TC,夜間漸變紅外線)
#   + B03 數值格點 0.02°(satellite/B03_2km,網頁 B03 頻道與讀值;0.01° 只在處理時用,不存)
SAT_VIS_BANDS = ("B01", "B02", "B03", "B04")
SAT_TC_RES = 0.01
SAT_B03 = (0.02, "reflectance", 0.5, 0.0, "%")
SAT_TC_QUALITY = 80          # WebP 品質:白天一張約 3 MB、夜間約 0.6 MB
SAT_WAIT_MIN = 60            # 掃描開始後幾分鐘內等資料上架,超過記 missed
SAT_B03_EVERY_MIN = 10       # 白天可見光(真實色 + B03)每次約下載 220 MB;改 30 或 60 可大幅省流量(夜間真實色照樣每 10 分)
SAT_KEEP_DAYS = int(os.environ.get("SAT_KEEP_DAYS", 5))   # 本機與 R2 衛星保留天數(一天約 1.1 GB);.env 可改

# ── ECMWF IFS 開放資料(台灣附近,pipeline/fetch_ecmwf.py)──
ECMWF_RESOL = "0p1"                       # 0.1°;"0p25" = 0.25°
ECMWF_AREA = (115.0, 17.0, 130.0, 28.0)   # lon_min, lat_min, lon_max, lat_max(151×111 格)
ECMWF_RUNS = (0, 12)                      # 只抓 00、12Z(06/18Z 只到 90 小時,也可加)
ECMWF_MAX_STEP = 84                       # 預報到幾小時(每 3 小時一步)
ECMWF_WAIT_H = 6                          # 起報後幾小時才開始檢查(通常 7–8 小時上架)
ECMWF_KEEP_DAYS = int(os.environ.get("ECMWF_KEEP_DAYS", 3))

# 日本氣象廳 AMeDAS 測站範圍(宮古、八重山、與那國),和 ECMWF 同區
JMA_AREA = ECMWF_AREA

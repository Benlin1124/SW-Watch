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

# TWD67 大地基準(GRS67 橢球 = aust_SA)+ 七參數 Helmert 轉 WGS84(同 EPSG:3828 的 towgs84 定義)。
# 以 O-A0002-001 各站官方 TWD67/WGS84 雙座標驗證:差距中位數 2 m。
# 註:pyproj 內建 EPSG:3821→4326 只有 ballpark 轉換(等於不轉,誤差約 850 m),不能用。
TWD67_PROJ = ("+proj=longlat +ellps=aust_SA "
              "+towgs84=-752,-358,-179,-0.0000011698,0.0000018398,0.0000009822,0.00002329 +no_defs")

# ── CWA 抓取 ──
# 會員 API 上限:24 小時 2 萬次、每日 2 GB。fileapi 只用來解析 S3 轉址,TTL 內不重複呼叫。
CWA_RESOLVE_TTL_SEC = 6 * 3600

# ── 保留策略 ──
KEEP_FULL_DAYS = 30          # 10 分鐘資料保留天數;更舊只留整點

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

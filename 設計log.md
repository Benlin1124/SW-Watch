# 劇烈天氣監控平台 — 設計 log

## 2026-10-22　初版規劃

### 0. 現況盤點（既有資產）

| Notebook | 已完成功能 | 可直接移植成 pipeline 的部分 |
|---|---|---|
| `Observations.ipynb` | CWA O-A0001-001 陣風/風速、O-A0002-001 雨量（10min~3days）散點圖，CWA 色階 | 下載 + JSON 解析 + 蒲福風級換算 + 雨量色階 |
| `Satellite_full_dvorak_(1).ipynb` | AWS `noaa-himawari9` B13 全盤 → satpy 重投影 → 增強色階；Dvorak 定位；best track 疊圖 | 找最新完整時次、B13 裁切、BD 色階、颱風中心定位 |
| `TY_ENS_3.ipynb` | ECMWF ENS / AIFS / GEFS / AIGEFS / WeatherLab 系集路徑統一成 `storm,name,member,ftype,tau,lat,lon,mslp`，IQR 離群判定 | 整套解碼器 + 離群標記，直接變成 JSON 輸出 |
| `Typhoon_alarm_check_optimized.ipynb` | CWA 颱風資料解析、暴風圈（geodesic 四象限）、雷達 O-A0059-001、縣市底圖 | 暴風圈幾何、雷達格點解碼 |

結論：**資料抓取與解析邏輯大多已經寫好**，平台工作主要是「改成排程腳本 + 輸出輕量檔案 + 做網頁前端」。

### 1. 平台功能（內容規劃）

| 模組 | 內容 | 資料來源 | 更新頻率 |
|---|---|---|---|
| 雷達回波 | 整合回波格點、近 1–3 小時動畫、滑鼠查 dBZ | CWA O-A0059-001 | 10 分 |
| 衛星雲圖 | B13 紅外線（BD/增強色階）、可加 B03 可見光、B08 水氣；動畫 | Himawari-9（AWS）| 10 分 |
| 測站觀測 | 溫度、風速/陣風（風級色）、氣壓、濕度；點擊看 24h 趨勢 | CWA O-A0001-001 / O-A0003-001 | 10 分–1 小時 |
| 雨量圖 | 測站雨量點 + 內插面圖；1h/3h/24h 累積切換 | CWA O-A0002-001（站點）→ Pi 上 IDW 內插 | 10 分 |
| 颱風路徑 | CWA 官方路徑 + 潛勢圈 + 暴風圈；**系集路徑比較**（ECMWF/AIFS/GEFS/AIGEFS/WeatherLab）；best track | CWA 颱風消息、ECMWF open data、NOMADS、WeatherLab | 6 小時（系集）/ 3 小時（官方）|
| 劇烈天氣警示 | 自動判斷：大雨/豪雨門檻、陣風 ≥ 8 級、強回波 ≥ 45 dBZ 面積 → 首頁警示列 | 由上述資料計算 | 隨資料 |

警示門檻（依 CWA 定義）：大雨 24h ≥ 80 mm 或 1h ≥ 40 mm；豪雨 24h ≥ 200 mm 或 3h ≥ 100 mm；大豪雨 24h ≥ 350 mm；超大豪雨 24h ≥ 500 mm。

頁面配置：一張全螢幕地圖，左側圖層開關（雷達 / 衛星 / 雨量 / 測站 / 颱風），底部時間軸可播放動畫，上方警示列，右側資訊面板（點測站或颱風時顯示詳細資料）。

### 2. 可行方案比較

| | A. 樹莓派 + GitHub Pages（PDF 原案）| B. 純 GitHub Actions | C. 樹莓派 + Cloudflare R2/Pages（建議）|
|---|---|---|---|
| 運算 | Pi 24h 排程 | GitHub 雲端 cron | Pi 24h 排程 |
| 儲存 | Git repo | Git repo | R2 物件儲存（10 GB 免費、流量不收費）|
| 前端 | GitHub Pages | GitHub Pages | Cloudflare Pages |
| 成本 | 電費 | 0 | 電費（免費額度內）|
| 主要風險 | 每 10 分鐘 commit 二進位檔，repo 歷史會快速膨脹（GitHub 建議 < 1 GB）| cron 常延遲 5–20 分鐘、不保證準時；satpy 每次都要重裝套件 | 要多學一套 R2 上傳（S3 相容，boto3 即可）|
| 適合 | 快速做出原型 | 不想顧硬體 | 長期營運 |

**建議：** 程式碼與網頁放 Git repo，資料檔放 R2（方案 C）。若想先用 A 驗證，資料改推到一個「每次 force-push 的 orphan 分支」，只保留最新狀態，避免歷史膨脹，之後再搬到 R2。

樹莓派規格：建議 Pi 5 / 8 GB + USB SSD 開機（PDF 也提到記憶卡寫入耗損）。Himawari B13 重投影是最吃記憶體的工作，裁切範圍要先縮小（例如 110–135E、15–30N）再 resample。

### 3. 系統架構

```
[CWA OpenData] [AWS Himawari-9] [ECMWF/NOMADS/WeatherLab]
        │              │                 │
        └──────── 樹莓派（systemd timer / cron）────────┐
                 fetch → 清洗/裁切 → 量化 → gzip         │ SQLite：同步狀態、
                         │                              │ 3 天測站紀錄（趨勢圖）
                         ▼                              │
              Cloudflare R2 / data 分支 ◄───────────────┘
                         │  （latest.json 索引 + 各圖層檔）
                         ▼
          靜態前端（MapLibre GL JS / Leaflet）
          瀏覽器下載 → 解壓 → Canvas 著色 → 疊在地圖上
```

### 4. 資料格式設計（前端「直讀」）

- 格點（雷達、衛星、雨量面）：`uint8` 量化陣列 `.bin`，gzip 壓縮，搭配 `meta.json`（範圍、解析度、nx/ny、量化公式、時間）。
  - 雷達：dBZ 以 0.5 dBZ 為一階存成 uint8；無資料存 255。
  - 衛星：亮溫 −100~+50 °C 以 0.6 °C 一階。
  - 前端用 `DecompressionStream('gzip')` 解壓 → `Uint8Array` → 查色表填 `ImageData`，所以色階可以在前端切換，滑鼠也能查原始數值。
- 測站：GeoJSON（每站一個 Feature，屬性含最新觀測）。
- 颱風：JSON（官方路徑 + 潛勢圈 polygon + 各系集成員線 + 系集平均）。
- 索引：`latest.json` 列出每個圖層最新時間與最近 N 個時次檔名，前端只先抓這支。

### 5. 目錄結構（建議）

```
劇烈天氣監測系統/
├─ notebooks/            # 現有 4 本移到這裡當研究用
├─ pipeline/             # 樹莓派執行
│  ├─ config.py          # 範圍、色階、門檻；金鑰從環境變數讀
│  ├─ fetch_radar.py
│  ├─ fetch_satellite.py
│  ├─ fetch_obs.py       # 測站 + 雨量 + 內插
│  ├─ fetch_typhoon.py   # 官方 + 系集（移植 TY_ENS_3）
│  ├─ alerts.py
│  ├─ publish.py         # 上傳 R2 / push data 分支、更新 latest.json、清舊檔
│  └─ db.sqlite
├─ web/                  # 靜態前端
│  ├─ index.html
│  ├─ js/ (map.js, layers/*.js, colormaps.js, timeline.js)
│  └─ css/
└─ 設計log.md
```

資料端：

```
data/
├─ latest.json
├─ radar/   YYYYMMDDHHMM.bin.gz（保留 24h）
├─ sat/     YYYYMMDDHHMM_B13.bin.gz（保留 24h）
├─ rain/    YYYYMMDDHHMM_{1h,3h,24h}.bin.gz
├─ obs/     stations.json（靜態）、latest.geojson
└─ typhoon/ latest.json、archive/YYYY/
```

### 6. 開發階段

1. **Phase 0　整理**（約 1 週）：把 notebook 拆成 `pipeline/` 模組，每支腳本可獨立執行、輸出到本機 `data/`；建立 repo、金鑰改環境變數。
2. **Phase 1　MVP**（2–3 週）：前端地圖 + 雷達 + 測站 + 雨量點；本機跑 pipeline，前端讀本機資料。
3. **Phase 2　衛星 + 颱風**（2–3 週）：B13 圖層、官方颱風路徑與潛勢圈、系集路徑開關。
4. **Phase 3　上線**（1 週）：樹莓派排程（systemd timer）、上傳 R2/Pages、舊檔清理、失敗通知（例如寄 email 或 LINE/Discord webhook）。
5. **Phase 4　加值**：時間軸動畫、劇烈天氣警示、雨量內插面、測站趨勢圖、Dvorak 自動定位、手機版版面。

### 7. 需注意事項

- **API 金鑰外洩**：`Observations.ipynb` 與 `Typhoon_alarm_check_optimized.ipynb` 裡寫死了 CWA 授權碼。上 Git 前要先移除，並到 opendata.cwa.gov.tw 重新申請一組新的。
- **Git repo 位置**：目前的 git repo 根目錄是整個使用者家目錄 `C:\Users\user`（尚無 commit）。要在本專案資料夾另外 `git init`，不然可能把整個家目錄推上去。
- 資料使用授權：CWA 開放資料要標示來源；WeatherLab / ECMWF open data 也要註明出處與授權條款。
- 時區：所有檔名一律用 UTC，前端顯示時再轉成台灣時間。

### 8. 待決定

- [ ] 採用方案 A 或 C（資料放 Git 還是 R2）→ 暫緩，先本機（見 v2）
- [x] 前端框架：純 JS + MapLibre（v2 預設採用）
- [ ] 颱風系集要放哪些模式（全部 5 個來源，還是只放 ECMWF + GEFS）
- [x] 雨量面圖：改抓 CWA 格點（見 v2）

---

## 2026-10-22　需求確認 v2（取代上面衝突的部分）

### 使用者決定

1. 雨量圖 → 直接抓氣象署的格點產品，不自己內插。
2. 衛星 → 除了 B13 紅外線，加 **可見光** 與 **水氣** 頻道。
3. 颱風路徑 → 可選特定初始時間（例 `2026101900`），並可調整預報的起始／結束時間，讓不同初始時間、不同模式能對齊在同一起點比較。
4. **所有圖層都能選歷史時間**。
5. 樹莓派先用**本機電腦**代替。
6. 新增**地圖擷取（截圖）功能**：可選尺寸、比例或自訂。
7. **暫不做**：劇烈天氣警示、手機版。

### 雨量資料（已實測 API，2026-10-22）

| 代碼 | 內容 | 格點 | 更新 |
|---|---|---|---|
| **O-B0045-001** | 過去 1 小時雷達定量降雨估計（QPESUMS QPE）| 0.0125°，441×561，起點 118E/20N | 10 分 |
| **O-A0040-004** | 日累積雨量（當日 00 時起）| 0.03°，起點 120E/21.88N 到 121.98E/25.45N | 30 分 |
| O-A0040-001/002 | 日累積雨量圖（JPG，大/小間距）| 圖片 | — 只當參考 |

- 兩者都是 JSON 內一大串逗號分隔的科學記號字串，無效值 −1；**座標為 TWD67**（與 WGS84 約差 800 m，轉換時一併校正）。
- 3h / 6h / 12h / 24h 累積：由本機歸檔的整點 O-B0045-001（每小時取一筆、互不重疊）加總產生。
- 「今日累積」直接用 O-A0040-004。
- 雨量色階沿用 `Observations.ipynb` 的 CWA 18 色。

### 衛星頻道

| 頻道 | 波長 | 用途 | 原始解析度 | 平台輸出 |
|---|---|---|---|---|
| B03 | 0.64 µm 可見光 | 白天雲紋、對流胞 | 0.5 km | 降至 0.01°，反照率 0–1 量化；夜間標示「無資料」|
| B08 | 6.2 µm 水氣 | 高層水氣、乾空氣入侵、槽線 | 2 km | 0.02°，亮溫量化 + 水氣色階 |
| B13 | 10.4 µm 紅外線 | 雲頂溫度、BD/增強色階 | 2 km | 0.02°，沿用現有 BD 色階 |

- 共用 `fetch_satellite.py`，只換頻道代碼；都從 AWS `noaa-himawari9` 抓。
- 範圍先用 110–135E、15–30N（可在 config 調整），先裁切再 resample 以省記憶體。
- 可見光之後可再加「真彩色（B01+B02+B03）」，目前不做。

### 颱風路徑：初始時間 / 預報區間對齊

資料歸檔：每個模式、每個初始時間存一個檔
`typhoon/ens/{MODEL}/{YYYYMMDDHH}.json`（欄位沿用 `storm,name,member,ftype,tau,lat,lon,mslp,outlier`）。
官方路徑：`typhoon/cwa/{YYYYMMDDHH}.json`（W-C0034-005，已確認可抓）。

前端控制項：

1. **初始時間選擇**：每個模式各自有下拉選單（列出已歸檔的 `YYYYMMDDHH`），也能一鍵「全部用同一個初始時間」。
2. **預報區間**，兩種模式切換：
   - **依預報時距（tau）**：雙把手滑桿，例如 tau 24–120 h，所有模式都套用同一段 tau。
   - **依有效時間（對齊起點）**：指定有效時間區間，例如 `2026102100 ~ 2026102500`，每個模式自動換算 `tau = 有效時間 − 初始時間`。這樣 10/19 00Z 和 10/20 12Z 的預報會從同一時刻開始畫，可直接比較。
3. 每條路徑起點標上有效時間；滑鼠移上去顯示 模式 / 成員 / 初始時間 / tau / 有效時間 / 氣壓。
4. 系集平均、控制報、離群成員可分別開關（離群判定沿用 `flag_outliers`）。
5. best track 疊加，可裁到同一個有效時間區間。

### 歷史時間

全域時間軸：選一個時間 → 每個圖層自動找「≤ 該時間的最近一筆」顯示，也可以播動畫。

| 圖層 | 歷史從何而來 | 備註 |
|---|---|---|
| 雷達、QPE、日累積雨量、測站 | 只能**從本機開始歸檔那天起**才有 | CWA API 只給最新一筆，所以排程要盡早開始跑 |
| 衛星 | AWS 有完整歷史，**任何時間都能補抓** | 提供 `backfill_satellite.py --start --end` |
| 颱風官方路徑 | 從開始歸檔起 | 只給最新 |
| 系集路徑 | ECMWF open data 只保留約數天；NOMADS 約一週；WeatherLab 有歷史 | 要盡早開始歸檔；必要時補抓 |

### 儲存量估計與保留策略

- 雷達 921×881 uint8 gz 約 30–80 KB/筆 → 約 10 MB/天
- QPE 441×561 → 約 2–3 MB/天
- 衛星三頻道（VIS 0.01°）→ 約 200–400 MB/天，大部分空間花在這裡
- 保留策略：10 分鐘資料保留 30 天；30 天後只保留整點；颱風與系集路徑永久保留。

### 本機執行（取代樹莓派）

- 單一 Python 常駐程式 `pipeline/scheduler.py`（APScheduler），依各資料更新頻率排程；Windows 可用「工作排程器」開機自動啟動。
- 輸出到 `data/`（靜態檔，格式和之前規劃的一樣），之後搬到樹莓派或雲端時，前端和資料格式都不用改。
- 本機瀏覽：`python -m http.server` 開 `web/` 加 `data/`。
- 每個時次的索引：`data/{layer}/index.json` 列出所有可用時間，讓前端的時間軸知道有哪些資料。

### 地圖擷取功能

- 工具列「📷 擷取」→ 地圖上出現一個擷取框，可以在框裡移動和縮放地圖，調整要擷取的範圍。
- 尺寸預設：16:9（1920×1080）、4:3（1600×1200）、1:1（1080×1080）、9:16（1080×1920）、A4 橫/直（300 dpi）、**自訂寬×高（px）**；鎖定比例開關；輸出倍率 1× / 2×。
- 可勾選加入：標題、資料時間（UTC + 台灣時間）、色階圖例、資料來源標示、比例尺、經緯網格。
- 實作：用目標尺寸在隱藏容器中重新渲染 MapLibre（`preserveDrawingBuffer`），再把圖例和文字畫到同一張 canvas 上，輸出 PNG。用重新渲染而不是直接裁切畫面，大圖才會清楚。

### v3 補充（2026-10-22）

- 前端確定：**純 JS + MapLibre GL JS**。
- 雨量面圖**兩種來源並存**，圖層面板可切換：
  1. CWA 格點：O-B0045-001（1h QPE）、O-A0040-004（今日累積）
  2. **自製 IDW**：用 O-A0002-001 測站雨量內插（kNN k=8、power=2、搜尋半徑 25 km、只畫陸地）
- **累積時間可選**：10 分、1、3、6、12、24、48、72 小時、今日累積；另可自訂起訖時間 → 前端把歸檔的整點 1h 格點加總（兩種來源都適用）。
- 系集路徑：全部模式都放（ECMWF、AIFS、GEFS、AIGEFS、WeatherLab 各模式）；使用者會先提供累積的歷史資料 → 用 `pipeline/import_ensemble.py` 匯入。
- **測站圖層可切換變數**：溫度、相對濕度、氣壓、風速＋風向（風標）、陣風（風級色）、雨量（各累積時間）、日最高/最低溫。資料合併 O-A0001-001（自動站）、O-A0003-001（局屬站）與 O-A0002-001（雨量站），每個時次存成一個檔，前端切換變數時不必再下載。點測站顯示完整數值。
- TWD67 → WGS84：由 O-A0002-001 每站雙座標實測平均位移 Δlon = +0.0081°、Δlat = −0.0018°，套用到所有 TWD67 格點的原點。

### 進度（2026-10-22）

Phase 0 + Phase 1 完成，已實際跑通：

- 專案內 `git init`（尚未 commit）；`.gitignore` 排除 `.env`、`data/`、`logs/`、`*.ipynb`（notebook 內有金鑰）。
- 金鑰放 `.env`（不進版控），範本 `.env.example`。
- `pipeline/`：`config.py`、`common.py`、`fetch_radar.py`、`fetch_rain_grid.py`、`fetch_stations.py`、`idw.py`、`fetch_typhoon.py`、`cleanup.py`、`scheduler.py`。
- 執行：`python -m pipeline.scheduler`（常駐）／`--once`（各跑一次）。
- 輸出格式：
  - 格點 `data/{layer}/{UTC YYYYMMDDHHMM}.bin.gz`，`index.json` 內含 `grid`（lon0/lat0/dx/nx/ny/dtype/scale/offset/nodata，origin=lower-left，已轉 WGS84）與 `times`。
  - 雷達 uint8（0.5 dBZ、offset −32；raw 0 = 範圍內無回波；255 = 範圍外）；雨量 uint16（0.1 mm）。
  - 測站 `data/stations/{stamp}.json`：`fields` + `rows`，約 1360 站，一個檔約 200 KB（gzip 前）。
  - 颱風官方先存原始 JSON（gz）。
- 單筆大小（實測）：雷達約 37 KB、QPE 1h 約 13 KB、IDW 各累積 5–13 KB。

### 更新後的開發階段

1. **Phase 0 整理**：建立獨立 git repo、移除寫死的金鑰、`pipeline/` 模組化、`config.py`。
2. **Phase 1 資料歸檔**（最優先，因為歷史資料只能從開始跑之後才有）：雷達、QPE、日累積雨量、測站、官方颱風、系集路徑的排程與歸檔 + `index.json`。
3. **Phase 2 前端基礎**：MapLibre 地圖、圖層開關、全域時間軸、雷達 / 雨量 / 測站圖層。
4. **Phase 3 衛星**：B03 / B08 / B13 + 補抓歷史腳本。
5. **Phase 4 颱風**：初始時間選擇、tau/有效時間區間對齊、系集路徑疊加。
6. **Phase 5 擷取功能**。
7. 之後：警示、手機版、搬到樹莓派 / 雲端。

# SW-Watch — Severe Weather Watch 劇烈天氣監控平台

整合雷達回波、衛星雲圖（可見光／水氣／紅外線）、測站觀測、雨量圖、ECMWF 預報（台灣附近 84 小時）與颱風（官方＋系集）預測路徑的網頁監控平台，所有圖層都可以選擇歷史時間。

- 資料處理：`pipeline/`（Python，本機或樹莓派排程執行，輸出靜態檔到 `data/`）
- 前端：`web/`（JS + MapLibre GL JS；衛星雲圖、ECMWF 預報、雷達回波、測站、氣象署颱風路徑、系集路徑、時間軸、同步切換）
- 部署（排程電腦 + Cloudflare R2 + GitHub Pages）：[部署說明.md](部署說明.md)
- 設計與進度：[設計log.md](設計log.md)

## 執行

```bash
pip install -r requirements.txt
cp .env.example .env          # 填入氣象資料開放平臺授權碼 CWA_KEY（與 R2 金鑰，見部署說明）
python -m pipeline.scheduler --once   # 各資料抓一次
python -m pipeline.scheduler          # 常駐排程
```

本機看網頁（在專案根目錄）：

```bash
python -m http.server 8765
# 瀏覽器開 http://127.0.0.1:8765/web/
```

## 雷達／颱風／測站風動畫（`pipeline.radar_video`）

把一段期間的雷達整合回波，或颱風路徑與測站風，做成縮時 MP4（每 10 分鐘一格）。

- **畫面**：4:3（1600×1200），左上角有標題、時間（台灣時間）與資料來源。
- **底圖**：Natural Earth 陸地加 `shp/TWN_CITY` 縣市界。
- **回波色階**：與網頁相同，畫面上不放色階，< 0 dBZ 不畫。

```bash
pip install matplotlib imageio-ffmpeg     # imageio-ffmpeg 內含 ffmpeg

# 單純雷達回波
python -m pipeline.radar_video --start "2026-10-22 00:00" --end "2026-10-24 20:00"
# 雷達 + 颱風路徑與暴風圈
python -m pipeline.radar_video --start "2026-10-22 00:00" --end "2026-10-24 20:00" --typhoon
# 不畫雷達：颱風 + 測站平均風（加 --gust 改陣風）
python -m pipeline.radar_video --start "2026-10-22 00:00" --end "2026-10-24 20:00" --no-radar --typhoon --wind [--gust]
# 只輸出一張 PNG 先看畫面（可給時間；省略 = 最新一筆）
python -m pipeline.radar_video --preview "2026-10-24 00:00" --typhoon
```

| 參數 | 說明 |
|---|---|
| `--start` / `--end` | 台灣時間 `YYYY-MM-DD HH:MM`。`--end` 省略 = 最新一筆。 |
| `--preview [時間]` | 只輸出一張 PNG，不做影片。 |
| `--fps` | 每秒格數，預設 8（三天約 48 秒）。 |
| `--gif` | 另外輸出 GIF。 |
| `--typhoon` | 疊加颱風路徑與暴風圈，檔名加 `_ty`。 |
| `--wind` | 疊加測站平均風，檔名加 `_wind`；加 `--gust` 改畫陣風，檔名改 `_gust`。 |
| `--no-radar` | 不畫雷達，畫面放大到台灣本島。時間改用測站快照，檔名開頭改 `station_`。 |
| `--local` | 只用本機 `data/`，不從 R2 下載。 |
| `--shp` | `TWN_CITY` 所在資料夾，預設 `shp/`。 |

**颱風**（`--typhoon`）
- 路徑只畫氣象署實際定位：黑線，每個定位一點，定位之間不內插。
- 紅點是當下的颱風中心。
- 黃圈、紅圈是 7 級、10 級暴風圈，取平均半徑的正圓，只畫外框。
- 不畫預報路徑。

**測站風**（`--wind`）
- 箭頭指向風吹去的方向，顏色和長度依蒲福風級，畫面底部有 0–17 級的橫式色階。
- 靜風或沒有風向畫成小圓點。
- 只畫觀測時間在畫面時間前 60 分鐘內的測站，整點那格也包含前一小時的觀測。
- 不含日本氣象廳測站。

**資料與輸出**
- 本機 `data/` 沒有的檔，自動從 R2 下載並快取在 `pipeline/.cache/`。
- 雷達缺漏的時段會略過。
- 輸出到 `charts/radar/`，檔名是 `{radar|station}_{開始}_{結束}[_ty][_wind|_gust].mp4`。
- MP4 寫檔要在前景執行。在背景執行時，ffmpeg 會出現 WinError 6。

資料來源：中央氣象署開放資料平臺、NOAA Himawari-9（AWS Open Data）、ECMWF Open Data、NOAA NOMADS、Google DeepMind WeatherLab。

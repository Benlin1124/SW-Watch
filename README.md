# SW-Watch — Severe Weather Watch 劇烈天氣監控平台

整合雷達回波、衛星雲圖（可見光／水氣／紅外線）、測站觀測、雨量圖與颱風（官方＋系集）預測路徑的網頁監控平台，所有圖層都可以選擇歷史時間。

- 資料處理：`pipeline/`（Python，本機或樹莓派排程執行，輸出靜態檔到 `data/`）
- 前端：`web/`（JS + MapLibre GL JS；目前有雷達回波、氣象署颱風路徑、時間軸、同步切換）
- 設計與進度：[設計log.md](設計log.md)

## 執行

```bash
pip install -r requirements.txt
cp .env.example .env          # 填入氣象資料開放平臺授權碼 CWA_KEY
python -m pipeline.scheduler --once   # 各資料抓一次
python -m pipeline.scheduler          # 常駐排程
```

本機看網頁（在專案根目錄）：

```bash
python -m http.server 8765
# 瀏覽器開 http://127.0.0.1:8765/web/
```

資料來源：中央氣象署開放資料平臺、NOAA Himawari-9（AWS Open Data）、ECMWF Open Data、NOAA NOMADS、Google DeepMind WeatherLab。

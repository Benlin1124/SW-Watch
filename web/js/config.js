// 資料來源:本機開發讀專案的 data/;部署到 github.io 時改讀 Cloudflare R2(建好 bucket 後填入網址)
const R2_URL = '';

export const DATA_BASE_URL =
  location.hostname.endsWith('github.io') && R2_URL ? R2_URL : new URL('../data/', location.href).href;

export const STEP_MIN = 10;          // 時間軸一格 = 10 分鐘
export const TIMELINE_DAYS = 7;      // 時間軸最多往回幾天
export const REFRESH_SEC = 60;       // 每分鐘重新讀 index.json
export const TW_OFFSET_MIN = 8 * 60; // 顯示用台灣時間

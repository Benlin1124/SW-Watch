// 資料來源:github.io 讀 Cloudflare R2;本機開發讀專案的 data/,網址加 ?data=r2 也可以改讀 R2
// R2_URL = R2 bucket 的公開網址(r2.dev 子網域或自訂網域),見 部署說明.md
const R2_URL = 'https://pub-95cef959cf924e2e938a1d1b2a833e45.r2.dev/';

const useR2 = R2_URL && (location.hostname.endsWith('github.io') || new URLSearchParams(location.search).get('data') === 'r2');
export const DATA_BASE_URL = useR2 ? R2_URL.replace(/\/?$/, '/') : new URL('../data/', location.href).href;

export const STEP_MIN = 10;          // 時間軸一格 = 10 分鐘
export const TIMELINE_DAYS = 7;      // 時間軸最多往回幾天
export const REFRESH_SEC = 60;       // 每分鐘重新讀 index.json
export const TW_OFFSET_MIN = 8 * 60; // 顯示用台灣時間

// 時間字串一律是 UTC 'YYYYMMDDHHMM'(和資料檔名相同),顯示時才轉台灣時間
import { STEP_MIN, TW_OFFSET_MIN } from './config.js';

export function toDate(s) {
  return new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12)));
}

export function toStamp(d) {
  return d.toISOString().slice(0, 16).replace(/[-T:]/g, '');
}

export const addMin = (s, m) => toStamp(new Date(toDate(s).getTime() + m * 60e3));
export const diffMin = (a, b) => (toDate(a) - toDate(b)) / 60e3;
export const nowStamp = () => toStamp(new Date());

export function floorStep(s, step = STEP_MIN) {
  const d = toDate(s);
  d.setUTCMinutes(d.getUTCMinutes() - (d.getUTCMinutes() % step));
  return toStamp(d);
}

const pad = (n) => String(n).padStart(2, '0');

/** 台灣時間顯示;style: 'full' = 2026/10/22 01:30、'md' = 10/22 01:30、'hm' = 01:30、'dh' = 22日08時 */
export function fmtTW(s, style = 'md') {
  const d = new Date(toDate(s).getTime() + TW_OFFSET_MIN * 60e3);
  const Y = d.getUTCFullYear(), M = pad(d.getUTCMonth() + 1), D = pad(d.getUTCDate());
  const h = pad(d.getUTCHours()), m = pad(d.getUTCMinutes());
  if (style === 'full') return `${Y}/${M}/${D} ${h}:${m}`;
  if (style === 'hm') return `${h}:${m}`;
  if (style === 'dh') return `${+D}日${h}時`;
  return `${M}/${D} ${h}:${m}`;
}

export function fmtUTC(s) {
  return `${s.slice(4, 6)}/${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}Z`;
}

/** 排序好的 times 中 ≤ T 的最後一筆;沒有回 null */
export function latestLE(times, T) {
  let lo = 0, hi = times.length - 1, ans = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= T) { ans = times[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

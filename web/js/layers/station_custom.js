// 測站自訂區段:區段累積雨量、區段最大 / 最小(溫度、濕度、氣壓、風速、陣風、10 分鐘 / 1 小時雨量)
// 時間一律 UTC 'YYYYMMDDHHMM';區段為 (start, end]
import { addMin, diffMin, toDate, toStamp } from '../time.js';

const DAY = 1440;
const TW_MIN = 8 * 60;
const AGG_HOURS = [72, 48, 24, 12, 6, 3, 2, 1];

/** 台灣日序號與是否剛好 00:00 */
function twDay(s) {
  const m = toDate(s).getTime() / 60e3 + TW_MIN;
  return { day: Math.floor(m / DAY), mid: m % DAY === 0 };
}
/** 台灣日序號的 00:00 → UTC stamp */
const midStamp = (day) => toStamp(new Date((day * DAY - TW_MIN) * 60e3));

const rowsOf = (snap) => {
  const f = Object.fromEntries(snap.fields.map((k, i) => [k, i]));
  return { f, rows: snap.rows };
};
const isJMA = (r, f) => f.type != null && r[f.type] === 'jma';

/**
 * 該快照各日累積欄位 → 起算的台灣日。CWA 的 rain_48h / rain_72h(Past2days / Past3days)是日曆日累積,不是滾動:
 * 一般時刻 今日 = 當天起、48h = 昨天起、72h = 前天起;
 * 00:00 那一筆還是前一天的:今日 = 前一天整天、48h = 前一天起、72h = 前兩天起(實測太平山 10/24 00:00)。
 */
function dayFields(s) {
  const { day, mid } = twDay(s);
  const d = mid ? day - 1 : day;
  return mid ? [['rain_today', d], ['rain_48h', d], ['rain_72h', d - 1]]
    : [['rain_today', d], ['rain_48h', d - 1], ['rain_72h', d - 2]];
}

/**
 * 區段累積雨量 = 終點的日累積(從起點那天 00 時起) − 起點當天已累積(今日);
 * 超過 3 天的部分逐日補:某天整天 = 隔天 00:00 那筆的「今日」,沒有就用隔天其他時刻的 48h − 今日。
 * get(stamp) → 快照(失敗回 null);times = 快照時間(排序)。回傳 { values: Map(id → mm), missing: [說明] }
 */
export async function customSum(start, end, get, times) {
  const missing = [];
  const have = new Set(times);
  const sd = twDay(start), Ds = sd.day;              // 起點那天(起點 00:00 → 當天,不用扣)
  const endSnap = have.has(end) ? await get(end) : null;
  if (!endSnap) return { values: new Map(), missing: [`終點 ${end} 沒有資料`] };
  let sub = null;
  if (!sd.mid) {
    const s = have.has(start) ? await get(start) : null;
    if (!s) return { values: new Map(), missing: [`起點 ${start} 沒有資料`] };
    const { f, rows } = rowsOf(s);
    sub = new Map(rows.map((r) => [r[f.id], r[f.rain_today]]));
  }
  // 終點用起算日最接近 Ds 的欄位
  const fields = dayFields(end).sort((a, b) => a[1] - b[1]);
  const exact = fields.find(([, d]) => d === Ds);
  const [field, from] = exact ?? fields[0];
  if (from < Ds) return { values: new Map(), missing: ['起點晚於終點'] };
  const { f, rows } = rowsOf(endSnap);
  const out = new Map();
  for (const r of rows) {
    if (isJMA(r, f) || r[f[field]] == null) continue;
    const s0 = sub ? sub.get(r[f.id]) : 0;
    if (s0 == null) continue;
    out.set(r[f.id], r[f[field]] - s0);
  }
  // Ds .. from-1 的整天雨量補上
  for (let d = Ds; d < from; d++) {
    const day = await dayTotal(d, get, times, have);
    if (!day) { missing.push(`缺 ${midStamp(d + 1)} 前後的日累積`); out.clear(); break; }
    for (const [id, v] of out) {
      const x = day.get(id);
      if (x == null) out.delete(id); else out.set(id, v + x);
    }
  }
  for (const [id, v] of out) out.set(id, Math.round(Math.max(0, v) * 10) / 10);
  return { values: out, missing };
}

async function dayTotal(d, get, times, have) {
  const m = midStamp(d + 1);
  if (have.has(m)) {
    const s = await get(m);
    if (s) { const { f, rows } = rowsOf(s); return new Map(rows.map((r) => [r[f.id], r[f.rain_today]])); }
  }
  const next = times.find((t) => t > m && t < midStamp(d + 2));   // 隔天其他時刻:48h(昨天起)− 今日
  const s = next && await get(next);
  if (!s) return null;
  const { f, rows } = rowsOf(s);
  return new Map(rows.map((r) => [r[f.id], r[f.rain_48h] == null || r[f.rain_today] == null ? null : r[f.rain_48h] - r[f.rain_today]]));
}

/**
 * 區段最大 / 最小:從終點往回,用預先算好的過去 N 小時最大 / 最小(agg_{N}h)首尾相接拼起來,
 * 不足 1 小時的零頭用 10 分鐘快照。getAgg(hours, stamp)、getIdx(hours) → 該時數的 index。
 * 回傳 { values: Map(id → [值, 發生時間]), missing: 筆數, pieces }
 */
export async function customExtreme(start, end, variable, stat, { get, times, getAgg, getIdx }) {
  const pieces = [];
  let cur = end, missing = 0;
  const have = new Set(times);
  while (diffMin(cur, start) >= 60) {
    let took = false;
    for (const h of AGG_HOURS) {
      if (h * 60 > diffMin(cur, start)) continue;
      const idx = await getIdx(h);
      if (!idx?.times?.includes(cur)) continue;
      pieces.push({ kind: 'agg', h, stamp: cur });
      cur = addMin(cur, -h * 60);
      took = true;
      break;
    }
    if (!took) { pieces.push({ kind: 'snap', stamp: cur }); cur = addMin(cur, -10); }
  }
  while (cur > start) { pieces.push({ kind: 'snap', stamp: cur }); cur = addMin(cur, -10); }

  const best = new Map();
  const better = stat === 'max' ? (a, b) => a > b : (a, b) => a < b;
  const put = (id, x, at) => {
    if (x == null) return;
    const c = best.get(id);
    if (!c || better(x, c[0]) || (x === c[0] && at && c[1] && at < c[1])) best.set(id, [x, at]);
  };
  for (const p of pieces) {
    if (p.kind === 'agg') {
      const a = await getAgg(p.h, p.stamp).catch(() => null);
      if (!a) { missing += p.h * 6; continue; }
      missing += a.expected - a.found;
      const j = a.vars.indexOf(variable), vals = a[stat], ts = a[`${stat}_t`];
      if (j < 0) continue;
      a.ids.forEach((id, i) => put(id, vals[i][j], ts?.[i]?.[j] ?? null));
    } else {
      const s = have.has(p.stamp) ? await get(p.stamp) : null;
      if (!s) { missing++; continue; }
      const { f, rows } = rowsOf(s);
      if (f[variable] == null) continue;
      const rain = variable.startsWith('rain');
      const lo = addMin(p.stamp, -10);
      for (const r of rows) {
        if (variable === 'gust' && f.gust_t != null && r[f.gust_t]) continue;   // 日本站陣風是當日最大,零頭不用
        const obs = r[f.obs] ?? '';
        if (!rain && !(obs > lo && obs <= p.stamp && obs >= start)) continue;   // 這 10 分鐘內的觀測才算
        const at = rain ? p.stamp : variable === 'gust' && f.gust_at != null && r[f.gust_at] ? r[f.gust_at] : obs;
        put(r[f.id], r[f[variable]], at);
      }
    }
  }
  return { values: best, missing, pieces };
}

/** datetime-local(台灣時間 'YYYY-MM-DDTHH:MM')↔ UTC stamp */
export const localToStamp = (v) => (v ? toStamp(new Date(`${v}:00+08:00`)) : '');
export function stampToLocal(s) {
  if (!s) return '';
  const d = new Date(toDate(s).getTime() + TW_MIN * 60e3);
  return d.toISOString().slice(0, 16);
}
/** 某 stamp 那天(台灣)00:00 */
export const twMidnight = (s) => midStamp(twDay(s).day);

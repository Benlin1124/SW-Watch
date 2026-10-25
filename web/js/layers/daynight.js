// 衛星「日夜」頻道的計算(不 import 其他模組:主執行緒與 daynight-worker.js 共用)
// 依每格太陽仰角,白天 B03 可見光、夜間 B07 短波紅外,晨昏之間漸變;夜間冷雲頂改用 B13

export const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));

// 日夜漸變:太陽仰角 night 以下全用 B07、day 以上全用 B03(度)
// 夜間冷雲頂:B07 在低溫訊號差(顆粒雜點)→ 依 B13 亮溫,cold[0] 以上用 B07、cold[1] 以下用 B13,之間溫度線性混合(°C)
export const DN = { night: 0, day: 10, cold: [-30, -50] };
const B07_GRAY = [[30, 0], [20, 0.18], [10, 0.38], [0, 0.55], [-20, 0.7], [-50, 0.85], [-80, 1]];   // 同 colormaps.js

function grayOf(t) {
  if (t >= B07_GRAY[0][0]) return 0;
  for (let i = 1; i < B07_GRAY.length; i++) {
    const [t1, g1] = B07_GRAY[i], [t0, g0] = B07_GRAY[i - 1];
    if (t >= t1) return Math.min(254, Math.round(255 * (g0 + ((g1 - g0) * (t0 - t)) / (t0 - t1))));
  }
  return 254;
}

/** 夜間灰階表:[B07 raw × 256 + B13 raw] → 灰階(255 = 缺值);B13 缺就只用 B07,B07 缺就用 B13 */
const nightCache = new Map();
function dnNightLUT(g07, g13) {
  const key = JSON.stringify([g07.scale, g07.offset, g13?.scale, g13?.offset]);
  if (nightCache.has(key)) return nightCache.get(key);
  const lut = new Uint8Array(65536).fill(255);
  for (let a = 0; a < 256; a++) {
    for (let b = 0; b < 256; b++) {
      const t07 = a === g07.nodata ? null : a * g07.scale + g07.offset;
      const t13 = !g13 || b === g13.nodata ? null : b * g13.scale + g13.offset;
      if (t07 === null && t13 === null) continue;
      const c = t13 === null ? 0 : t07 === null ? 1 : Math.max(0, Math.min(1, (DN.cold[0] - t13) / (DN.cold[0] - DN.cold[1])));
      lut[(a << 8) | b] = grayOf(c === 0 ? t07 : c === 1 ? t13 : (1 - c) * t07 + c * t13);
    }
  }
  nightCache.set(key, lut);
  return lut;
}
export const GRAY_LUT = Uint32Array.from({ length: 256 }, (_, v) => (v === 255 ? 0 : (0xff000000 | (v << 16) | (v << 8) | v) >>> 0));

/** 太陽赤緯與時間(NOAA 近似式,含均時差);時間取掃描開始 + 5 分(全盤掃到台灣附近約這時候) */
export function sunAt(stamp) {
  const t = Date.UTC(+stamp.slice(0, 4), +stamp.slice(4, 6) - 1, +stamp.slice(6, 8), +stamp.slice(8, 10), +stamp.slice(10, 12) + 5);
  const d = new Date(t), doy = (t - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5;
  const min = d.getUTCHours() * 60 + d.getUTCMinutes();
  const gm = (2 * Math.PI / 365) * (doy + (min / 60 - 12) / 24);
  const eqt = 229.18 * (0.000075 + 0.001868 * Math.cos(gm) - 0.032077 * Math.sin(gm) - 0.014615 * Math.cos(2 * gm) - 0.040849 * Math.sin(2 * gm));
  const decl = 0.006918 - 0.399912 * Math.cos(gm) + 0.070257 * Math.sin(gm) - 0.006758 * Math.cos(2 * gm)
    + 0.000907 * Math.sin(2 * gm) - 0.002697 * Math.cos(3 * gm) + 0.00148 * Math.sin(3 * gm);
  return { decl, min: min + eqt };
}

/** 太陽仰角(度) */
export function sunElevation({ decl, min }, lat, lon) {
  const ha = (((min + 4 * lon) / 4 - 180) * Math.PI) / 180, p = (lat * Math.PI) / 180;
  return (Math.asin(Math.sin(p) * Math.sin(decl) + Math.cos(p) * Math.cos(decl) * Math.cos(ha)) * 180) / Math.PI;
}

/** 範圍內有沒有地方太陽仰角超過 DN.night(粗略取 9×9 點) */
export function hasDaylight(sun, g) {
  for (let i = 0; i <= 8; i++) {
    for (let j = 0; j <= 8; j++) {
      if (sunElevation(sun, g.south + ((g.north - g.south) * i) / 8, g.west + ((g.east - g.west) * j) / 8) > DN.night) return true;
    }
  }
  return false;
}

/** 日夜合成 → { code(灰階,255 = 缺值), g }。
 *  B03(0.01°)與 B07(0.02°)範圍相同、格點剛好兩倍 → 有 B03 時用 B03 解析度,B07 每格放大成 2×2。
 *  權重 w = 太陽仰角在 DN.night → DN.day 之間線性漸變;可見光除以 sin(仰角)補償晨昏變暗(仰角 < DN.day 時不再放大) */
export function dnCode({ r07, r13, g07, g13 }, vis, sun) {
  const r03 = vis?.r03 ?? null;
  const g = r03 ? vis.g03 : g07, f = r03 ? 2 : 1;
  const nightLUT = dnNightLUT(g07, g13);
  const r13x = r13 ?? new Uint8Array(r07.length).fill(255);
  const ys = mercY(g.south), yn = mercY(g.north);
  const B = 16;                                                   // 太陽仰角每 16 格算一次
  const code = new Uint8Array(g.nx * g.ny);
  const sMax = Math.sin((DN.day * Math.PI) / 180);
  // 可見光灰階查表:補償倍率 k(1 ~ 1/sin(DN.day))量化成 KQ 級,每級一張 raw → 灰階表(不用每格算次方)
  const KQ = 48, kMax = 1 / sMax, dayLUT = [];
  if (r03) {
    for (let q = 0; q < KQ; q++) {
      const k = 1 + ((kMax - 1) * q) / (KQ - 1), t = new Uint8Array(256);
      for (let v = 0; v < 255; v++) t[v] = Math.min(254, Math.round(255 * Math.pow(Math.min(1, ((v * g.scale + g.offset) * k) / 100), 0.6)));
      dayLUT.push(t);
    }
  }
  const nd03 = g.nodata;
  for (let y0 = 0; y0 < g.ny; y0 += B) {
    const lat = Math.atan(Math.sinh(ys + ((Math.min(y0 + B / 2, g.ny - 1) + 0.5) / g.ny) * (yn - ys))) * 180 / Math.PI;
    const y1 = Math.min(y0 + B, g.ny);
    for (let x0 = 0; x0 < g.nx; x0 += B) {
      const lon = g.west + ((Math.min(x0 + B / 2, g.nx - 1) + 0.5) / g.nx) * (g.east - g.west);
      const el = sunElevation(sun, lat, lon);
      const w = r03 ? Math.max(0, Math.min(1, (el - DN.night) / (DN.day - DN.night))) : 0;
      const x1 = Math.min(x0 + B, g.nx);
      const day = w > 0 ? dayLUT[Math.round(((1 / Math.max(Math.sin((el * Math.PI) / 180), sMax) - 1) / (kMax - 1)) * (KQ - 1))] : null;
      for (let y = y0; y < y1; y++) {
        const row = y * g.nx, row07 = ((y / f) | 0) * g07.nx;
        for (let x = x0; x < x1; x++) {
          const j = row07 + ((x / f) | 0);
          const n = nightLUT[(r07[j] << 8) | r13x[j]];             // 255 = 缺值
          if (!day) { code[row + x] = n; continue; }
          const v = r03[row + x];
          const d = v === nd03 ? n : day[v];
          code[row + x] = w === 1 || n === 255 || d === 255 ? d : Math.round(w * d + (1 - w) * n);
        }
      }
    }
  }
  return { code, g };
}

/** B03 取每 2×2 的左下那格,縮成 B07 格點(滑鼠讀值用,快取不必留 0.01° 原檔) */
export function halve(r03, g03) {
  const nx = g03.nx >> 1, ny = g03.ny >> 1, out = new Uint8Array(nx * ny);
  for (let y = 0; y < ny; y++) {
    const src = y * 2 * g03.nx, dst = y * nx;
    for (let x = 0; x < nx; x++) out[dst + x] = r03[src + x * 2];
  }
  return out;
}

// 色階:格點 raw 整數 → RGBA(Uint32,little-endian 的 ABGR),一次建好查表
// 雷達色階沿用 Typhoon_alarm_check_optimized.ipynb 的 DBZ_LEVELS / DBZ_COLORS

export const DBZ_LEVELS = [-5, 0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 85];
export const DBZ_COLORS = ['#ffffff', '#98ffff', '#009aff', '#1919ff', '#19ff19', '#19cd19',
  '#19A019', '#fefe08', '#ffcb00', '#ff9c00', '#fe0005', '#c90200',
  '#9d0000', '#9a009d', '#cf00d7', '#ff00f7', '#fdcafe'];

function packHex(hex, alpha = 255) {
  const n = parseInt(hex.slice(1, 7), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return ((alpha << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

/** 分級色階查表:v < minVisible 或 nodata → 透明;超過最後一級用最後一色 */
export function binLUT(spec, levels, colors, { minVisible = -Infinity } = {}) {
  const lut = new Uint32Array(spec.nodata + 1);
  const packed = colors.map((c) => packHex(c));
  for (let raw = 0; raw < spec.nodata; raw++) {
    const v = raw * spec.scale + spec.offset;
    if (v < minVisible || v < levels[0]) continue;
    let i = 0;
    while (i + 1 < levels.length && v >= levels[i + 1]) i++;
    lut[raw] = packed[Math.min(i, packed.length - 1)];
  }
  return lut;
}

/** notebook 的作法是 dBZ < 0 不畫(含 raw 0 = 範圍內無回波) */
export const radarLUT = (spec) => binLUT(spec, DBZ_LEVELS, DBZ_COLORS, { minVisible: 0 });

export function legendHTML(title, levels, colors, from = 1, w = 22) {
  const bar = colors.slice(from).map((c) => `<span style="background:${c};width:${w}px"></span>`).join('');
  const labels = levels.slice(from, -1).map((v) => `<span style="width:${w}px">${v}</span>`).join('');
  return `<div class="legend-title">${title}</div><div class="legend-bar">${bar}</div><div class="legend-labels">${labels}</div>`;
}

// ── 測站色階:levels[i] = 第 i 色的下界,最後一個是上界(只給圖例用)──
function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }

/** 依錨點顏色線性內插出 n 色 */
function ramp(anchors, n) {
  const rgb = anchors.map(hexToRgb);
  return Array.from({ length: n }, (_, i) => {
    const t = (i / Math.max(n - 1, 1)) * (rgb.length - 1), k = Math.min(Math.floor(t), rgb.length - 2), f = t - k;
    return '#' + rgb[k].map((c, j) => Math.round(c + (rgb[k + 1][j] - c) * f).toString(16).padStart(2, '0')).join('');
  });
}

export const BEAUFORT = [0, 0.3, 1.6, 3.4, 5.5, 8.0, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7, 37.0, 41.5, 46.2, 51.0, 56.1];

/** 深色底用白字 */
const isDark = (hex) => { const [r, g, b] = hexToRgb(hex); return 0.299 * r + 0.587 * g + 0.114 * b < 140; };

/** 風速(m/s)→ 蒲福風級 */
export function beaufort(ms) {
  let k = 0;
  while (k + 1 < BEAUFORT.length && ms >= BEAUFORT[k + 1]) k++;
  return k;
}

/** 風級圖例:每級一格,上排級數、下排該級下界風速 */
export function beaufortLegendHTML(title, colors) {
  const cell = (c, k) => `<span style="background:${c};width:28px;height:20px;text-align:center;font-size:13px;font-weight:700;line-height:20px;color:${isDark(c) ? '#fff' : '#222'}">${k}</span>`;
  const ms = BEAUFORT.map((v) => `<span style="width:28px;font-size:11px;transform:translateX(-8px)">${v}</span>`).join('');
  return `<div class="legend-title">${title}</div><div class="legend-bar">${colors.map(cell).join('')}</div>
    <div class="legend-labels">${ms}</div>`;
}

const range = (a, b, step) => Array.from({ length: Math.round((b - a) / step) + 1 }, (_, i) => +(a + i * step).toFixed(1));

export const SCALES = {
  // 氣象署雨量色階(第一級改成 0.5,讓 10 分鐘雨量 0.5 mm 也看得到)
  rain: { levels: [0.5, 2, 6, 10, 15, 20, 30, 40, 50, 70, 90, 110, 130, 150, 200, 300, 400],
    colors: ['#9bffff', '#00cfff', '#0198ff', '#0165ff', '#309901', '#32ff00', '#f8ff00', '#ffcb00',
      '#ff9a00', '#fa0300', '#cc0003', '#a00000', '#98009a', '#c304cc', '#f805f3', '#fecbff'] },
  temp: { levels: [-4, ...range(0, 38, 2), 40], colors: ramp(['#2c1b8f', '#2f6bd9', '#6ec6f0', '#9be27a', '#f7e65a', '#f39a2d', '#d7301f', '#7a0177'], 21) },
  rh: { levels: range(0, 100, 10), colors: ramp(['#8c510a', '#d8b365', '#f6e8c3', '#c7eae5', '#5ab4ac', '#01665e', '#08306b'], 10) },
  pres: { levels: range(980, 1032, 4), colors: ramp(['#7a0177', '#d7301f', '#f39a2d', '#f7e65a', '#9be27a', '#6ec6f0', '#2f6bd9'], 13) },
  // 蒲福風級(氣象署 0–17 級):levels[k] = 第 k 級的下界(m/s),一級一色
  // 分組:0–4 藍、5–6 綠、7–9 黃、10–11 紅、12–13 紫、14–15 深紫、16 以上更深
  wind: { levels: BEAUFORT,
    colors: ['#eef5fb', '#c6dbef', '#9ecae1', '#6baed6', '#2171b5',
      '#74c476', '#238b45',
      '#fff59d', '#ffe03a', '#f5b700',
      '#ef5350', '#b71c1c',
      '#ce93d8', '#9c27b0',
      '#6a1b9a', '#4a148c',
      '#2a0a4a', '#14001f'] },
};

/** MapLibre step 運算式:值 → 顏色(低於第一級用第一色) */
export function stepExpr(scale, prop = 'v') {
  const e = ['step', ['get', prop], scale.colors[0]];
  for (let i = 1; i < scale.colors.length; i++) e.push(scale.levels[i], scale.colors[i]);
  return e;
}

// ── 衛星色階:每個 raw(0–254)一個顏色,255 = nodata 透明 ──
// B13 增強色階沿用 Satellite_full_dvorak_(1).ipynb(對流色段 + 兩段灰階)
const BD_LEVELS = [-100, -86, -81, -76, -70, -64, -54, -42, -31,
  -27, -23, -19, -15, -11, -7, -3, 1, 5, 9,
  11, 13, 15, 17, 19, 21, 23, 25, 27, 29];
const BD_COLORS = ['#ffffff', '#001212', '#fe0000', '#00c8c8', '#ff00fe', '#ffff00', '#01af00', '#003cf6',
  '#e2e2e2', '#dadada', '#d1d1d1', '#c6c6c6', '#bdbdbd', '#aeaeae', '#a0a0a0', '#939393', '#868686', '#7a7a7a',
  '#f3f3f3', '#e2e2e2', '#cecece', '#b5b5b5', '#959595', '#7a7a7a', '#5f5f5f', '#404040', '#1d1d1d', '#000000'];
const WV_ANCHORS = [[-85, '#ffffff'], [-65, '#9ecae1'], [-50, '#2166ac'], [-40, '#1a1a2e'], [-30, '#7f4f24'], [-18, '#e0a050'], [-5, '#fff1c1']];

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const gray = (g) => { const v = Math.round(clamp01(g) * 255); return ((255 << 24) | (v << 16) | (v << 8) | v) >>> 0; };

function anchorColor(anchors, v) {
  if (v <= anchors[0][0]) return anchors[0][1];
  for (let i = 1; i < anchors.length; i++) {
    if (v <= anchors[i][0]) {
      const [a, ca] = anchors[i - 1], [b, cb] = anchors[i];
      const f = (v - a) / (b - a), x = hexToRgb(ca), y = hexToRgb(cb);
      return '#' + x.map((c, j) => Math.round(c + (y[j] - c) * f).toString(16).padStart(2, '0')).join('');
    }
  }
  return anchors[anchors.length - 1][1];
}

/** 衛星值 → 顏色函式(回傳 packed ABGR);style:B13 'bd' | 'gray' */
function satColorFn(band, style) {
  if (band === 'B03') return (v) => gray(Math.pow(clamp01(v / 100), 0.6));
  if (band === 'B08') return (v) => packHex(anchorColor(WV_ANCHORS, v));
  if (style === 'gray') return (v) => gray((40 - v) / 120);   // −80 °C 白 → +40 °C 黑
  return (v) => {
    let i = 0;
    while (i + 1 < BD_LEVELS.length - 1 && v >= BD_LEVELS[i + 1]) i++;
    return packHex(BD_COLORS[Math.min(i, BD_COLORS.length - 1)]);
  };
}

export function satLUT(spec, band, style = 'bd') {
  const f = satColorFn(band, style);
  const lut = new Uint32Array(spec.nodata + 1);
  for (let raw = 0; raw < spec.nodata; raw++) lut[raw] = f(raw * spec.scale + spec.offset);
  return lut;
}

const cssOf = (p) => `rgb(${p & 255},${(p >> 8) & 255},${(p >>> 16) & 255})`;

/** 連續色階圖例:取樣顏色做漸層,ticks 標在對應位置 */
export function satLegendHTML(title, band, style, [vmin, vmax], ticks) {
  const f = satColorFn(band, style), n = 120, stops = [];
  for (let i = 0; i < n; i++) {
    const v = vmin + ((i + 0.5) / n) * (vmax - vmin);
    stops.push(`${cssOf(f(v))} ${(i / n) * 100}% ${((i + 1) / n) * 100}%`);
  }
  const pos = (v) => ((v - vmin) / (vmax - vmin)) * 100;
  const labels = ticks.map((t) => `<span style="position:absolute;left:${pos(t)}%;transform:translateX(-50%)">${t}</span>`).join('');
  return `<div class="legend-title">${title}</div>
    <div style="width:360px;height:14px;background:linear-gradient(90deg,${stops.join(',')})"></div>
    <div class="legend-labels" style="position:relative;height:14px;width:360px">${labels}</div>`;
}

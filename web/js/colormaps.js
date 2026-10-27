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

/** 分級圖例:數字標在色格交界(該色下界);數字太長放不下時,格子放寬,還是太擠就隔幾個標一個。
 *  有 ticks 時色格縮窄到總寬約 460 px,只標 ticks 裡的值(含最後的上界) */
/** 色階標題旁的 ⓘ:點了才顯示說明(app.js updateLegend 處理開關;地圖擷取不畫) */
export const infoHTML = (text) => `<span class="info" tabindex="0" role="button" aria-label="說明" title="說明">i<span class="info-pop">${text}</span></span>`;

/** 在色階 HTML 的第一個標題(legend-title)後面加 ⓘ */
export const withInfo = (html, text) => html.replace('</div>', `${infoHTML(text)}</div>`);

export function legendHTML(title, levels, colors, from = 1, w = 22, ticks = null) {
  const cols = colors.slice(from), labs = levels.slice(from, colors.length + 1);
  const need = Math.max(...labs.map((v) => String(v).length)) * 6.5 + 6;     // 11px 字一個標籤要的寬度
  w = ticks ? Math.max(6, Math.floor(460 / cols.length)) : Math.max(w, Math.min(need, Math.floor(460 / cols.length)));
  const every = Math.ceil(need / w);
  const show = (v, i) => (ticks ? ticks.includes(v) : i < cols.length && !(i % every));
  const bar = cols.map((c) => `<span style="background:${c};width:${w}px"></span>`).join('');
  const labels = labs.map((v, i) => (show(v, i) ? `<span style="left:${i * w}px">${v}</span>` : '')).join('');
  return `<div class="legend-title">${title}</div><div class="legend-bar">${bar}</div>
    <div class="legend-labels abs" style="width:${cols.length * w}px">${labels}</div>`;
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

// 最後的 61.3 = 17 級上界;61.3 以上(超過 17 級)另一色,標 >17
export const BEAUFORT = [0, 0.3, 1.6, 3.4, 5.5, 8.0, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7, 37.0, 41.5, 46.2, 51.0, 56.1, 61.3];

/** 深色底用白字 */
const isDark = (hex) => { const [r, g, b] = hexToRgb(hex); return 0.299 * r + 0.587 * g + 0.114 * b < 140; };

/** 風速(m/s)→ 蒲福風級 */
export function beaufort(ms) {
  let k = 0;
  while (k + 1 < BEAUFORT.length && ms >= BEAUFORT[k + 1]) k++;
  return k;
}

/** 風級顯示文字:超過 17 級(61.3 以上)為 >17 */
export const bfLabel = (ms) => { const k = beaufort(ms); return k > 17 ? '>17' : String(k); };

/** 風級圖例:每級一格,上排級數、下排該級下界風速 */
export function beaufortLegendHTML(title, colors) {
  const cell = (c, k) => `<span style="background:${c};width:28px;height:20px;text-align:center;font-size:${k > 17 ? 11 : 13}px;font-weight:700;line-height:20px;color:${isDark(c) ? '#fff' : '#222'}">${k > 17 ? '>17' : k}</span>`;
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
  // 溫度:使用者提供的色階圖取色;0°C 以下每 2 度一色、0–40°C 每 1 度一色,40 以上用最後一色
  temp: { levels: [...range(-14, -2, 2), ...range(0, 40, 1)],
    colors: ['#3c016e', '#5a009e', '#6d00be', '#8200e5', '#9910fe', '#a42dfd', '#bf69fd',
      '#010075', '#0101a1', '#0100c7', '#0000ea', '#0d57fd', '#0087ed', '#179bff', '#00cefe', '#02e5fd', '#01fffd',
      '#8ffefe', '#096b16', '#217900', '#2e9801', '#35bc00', '#3cd101', '#44f200', '#7aff46', '#a6fe83', '#d5fec4',
      '#fcfdaf', '#fdfc7d', '#f4f27b', '#f1ee53', '#efd856', '#f1bc54', '#ecad2a', '#d89510', '#b17c0c', '#97670b',
      '#fe9595', '#fd7c7c', '#fe6464', '#fb4949', '#fc1f21', '#c10302', '#a700a6', '#d000d0', '#fa01f8', '#fd5afc'],
    ticks: [-10, 0, 5, 10, 15, 20, 25, 30, 35, 40] },
  rh: { levels: range(0, 100, 10), colors: ramp(['#8c510a', '#d8b365', '#f6e8c3', '#c7eae5', '#5ab4ac', '#01665e', '#08306b'], 10) },
  // 氣壓:颱風中心可到 920 hPa 以下;低壓段 10 hPa 一級、980 以上 5、1000 以上 4
  pres: { levels: [920, 930, 940, 950, 960, 970, 980, 985, 990, 995, 1000, 1004, 1008, 1012, 1016, 1020, 1024, 1028, 1032],
    colors: ramp(['#2d0a3e', '#7a0177', '#c51b8a', '#d7301f', '#f39a2d', '#f7e65a', '#9be27a', '#6ec6f0', '#2f6bd9'], 18) },
  // 蒲福風級(氣象署 0–17 級):levels[k] = 第 k 級的下界(m/s),一級一色
  // 分組:0–4 藍、5–6 綠、7–9 黃、10–11 紅、12–13 紫、14–15 深紫、16–17 更深、>17(61.3 以上)灰
  wind: { levels: BEAUFORT,
    colors: ['#eef5fb', '#c6dbef', '#9ecae1', '#6baed6', '#2171b5',
      '#74c476', '#238b45',
      '#fff59d', '#ffe03a', '#f5b700',
      '#ef5350', '#b71c1c',
      '#ce93d8', '#9c27b0',
      '#6a1b9a', '#4a148c',
      '#2a0a4a', '#14001f',
      '#7a7a7a'] },   // >17(61.3 以上)
  // ── 海象(layers/marine.js)──
  // 浪高(m),依浪級分色:1 m 以下藍、小浪 1–2 綠、中浪 2–3 黃、大浪 3–6 橘紅、巨浪 6 以上紫(見 WAVE_CLASSES)
  wave: { levels: [0, 0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 9],
    colors: ['#deebf7', '#9ecae1', '#74c476', '#31a354', '#fff59d', '#f5b700', '#fdae61', '#f46d43', '#d73027',
      '#ce93d8', '#9c27b0', '#4a148c'],
    ticks: [0, 1, 2, 3, 4, 5, 6, 7, 9] },
  period: { levels: [0, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16],
    colors: ramp(['#edf8b1', '#7fcdbb', '#2c7fb8', '#253494', '#7a0177'], 11) },
  // 潮高(m,臺灣高程基準;離島為當地平均海水面):負藍正紅,每 0.25 m 一級
  tide: { levels: Array.from({ length: 21 }, (_, i) => -2.5 + i * 0.25),
    colors: ramp(['#053061', '#2166ac', '#92c5de', '#f7f7f7', '#f4a582', '#b2182b', '#67001f'], 21),
    ticks: [-2, -1, 0, 1, 2] },
  current: { levels: [0, 0.1, 0.2, 0.3, 0.5, 0.7, 1, 1.5, 2],
    colors: ramp(['#d0e1f2', '#4a98c9', '#41ab5d', '#fdd835', '#f46d43', '#a50026'], 9) },
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
// notebook 色條刻度(cbar_ticks)
const BD_TICKS = [-86, -81, -76, -70, -64, -54, -42, -31, 9, 25];
const WV_ANCHORS = [[-85, '#ffffff'], [-65, '#9ecae1'], [-50, '#2166ac'], [-40, '#1a1a2e'], [-30, '#7f4f24'], [-18, '#e0a050'], [-5, '#fff1c1']];

const clamp01 = (x) => Math.max(0, Math.min(1, x));
// B07 灰階錨點 [°C, 灰階 0 黑 – 1 白]
const B07_GRAY = [[30, 0], [20, 0.18], [10, 0.38], [0, 0.55], [-20, 0.7], [-50, 0.85], [-80, 1]];
/** 錨點(依值遞減排列)之間線性內插,範圍外取端點 */
function piecewise(anchors, v) {
  if (v >= anchors[0][0]) return anchors[0][1];
  for (let i = 1; i < anchors.length; i++) {
    const [v1, g1] = anchors[i], [v0, g0] = anchors[i - 1];
    if (v >= v1) return g0 + ((g1 - g0) * (v0 - v)) / (v0 - v1);
  }
  return anchors[anchors.length - 1][1];
}
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
  // B07 短波紅外(夜間低雲、霧):分段灰階,冷白暖黑。暖段(30 → 0 °C)拉開低雲(約 5–20 °C)和海面(約 25 °C)的對比;
  // 冷段(0 → −80 °C)壓縮但保留層次,高雲不會整片死白
  if (band === 'B07') return (v) => gray(piecewise(B07_GRAY, v));
  if (band === 'B08') return (v) => packHex(anchorColor(WV_ANCHORS, v));
  // 比照 notebook:gray_r,vmin=190 K(−83.15 °C)白 → vmax=300 K(26.85 °C)黑,線性
  if (style === 'gray') return (v) => gray((26.85 - v) / 110);
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

// ── 夜間低雲 / 霧(B13 − B07 亮溫差)──
// 夜間水雲(低雲、霧)在 3.9 µm 放射率較低 → B07 比 B13 冷,差值約 +1.5 ~ +5 °C;晴空約 0,高層冰雲多為負值。
// 底圖 B13 灰階(同 notebook,冷白暖黑),差值 ≥ 1 °C 且 B13 > −20 °C(排除高雲)的地方疊青色,差越大越濃。
// 白天 B07 含太陽反射,差值變成大負值,這個產品不適用(白天看低雲用 B03 可見光)。
// 編碼:code = 差值等級 bi(0–9)× 25 + B13 灰階等級 gi(0–24),255 = 缺值
export const FOG = { gray: 25, levels: 10, step: 0.5, min: 1, color: [0, 229, 255] };

export function fogCode(t13, t07) {
  const gi = Math.max(0, Math.min(24, Math.round(((26.85 - t13) / 110) * 24)));
  const d = t13 - t07;
  const bi = t13 <= -20 || d < FOG.min ? 0 : Math.min(FOG.levels - 1, 1 + Math.floor((d - FOG.min) / FOG.step));
  return bi * FOG.gray + gi;
}

const fogColor = (bi, gi) => {
  const g = (gi / 24) * 255, a = (bi / (FOG.levels - 1)) * 0.85;
  const [r, gg, b] = FOG.color.map((c) => Math.round(g + (c - g) * a));
  return ((255 << 24) | (b << 16) | (gg << 8) | r) >>> 0;
};

export function fogLUT() {
  const lut = new Uint32Array(256);
  for (let bi = 0; bi < FOG.levels; bi++) for (let gi = 0; gi < FOG.gray; gi++) lut[bi * FOG.gray + gi] = fogColor(bi, gi);
  return lut;               // 255 → 0(透明)
}

export function fogLegendHTML(title) {
  const n = FOG.levels - 1, w = 40;
  const cells = Array.from({ length: n }, (_, i) => `<span style="width:${w}px;background:${cssOf(fogColor(i + 1, 6))}"></span>`).join('');
  const labels = Array.from({ length: n }, (_, i) => FOG.min + i * FOG.step)
    .map((v, i) => (i % 2 ? '' : `<span style="left:${i * w}px">${v}</span>`)).join('');
  return `<div class="legend-title">${title}${infoHTML('底圖 B13 灰階；青色 = 低雲／霧（夜間適用，白天請看 B03）')}</div><div class="legend-bar">${cells}</div>
    <div class="legend-labels abs" style="width:${n * w}px">${labels}<span style="left:${n * w}px">°C</span></div>`;
}

/** B13 增強色階圖例:比照 notebook 的 BoundaryNorm 色條,每格等寬,刻度標在格界;太擠的刻度排到第二列 */
function bdLegendHTML(title, ticks) {
  const W = 420, n = BD_COLORS.length;
  const cells = BD_COLORS.map((c) => `<span style="flex:1;background:${c}"></span>`).join('');
  let last = [-1e9, -1e9];
  const labels = ticks.map((t) => {
    const x = (BD_LEVELS.indexOf(t) / n) * W;
    const row = x - last[0] >= 22 ? 0 : 1;
    last[row] = x;
    return `<span style="position:absolute;left:${x}px;top:${row * 12}px;transform:translateX(-50%)">${t}</span>`;
  }).join('');
  return `<div class="legend-title">${title}</div>
    <div style="display:flex;width:${W}px;height:14px;outline:1px solid rgba(128,128,128,.5)">${cells}</div>
    <div class="legend-labels" style="position:relative;height:26px;width:${W}px">${labels}</div>`;
}

/** 連續色階圖例:取樣顏色做漸層,ticks 標在對應位置 */
export function satLegendHTML(title, band, style, [vmin, vmax], ticks) {
  if (band === 'B13' && style === 'bd') return bdLegendHTML(title, BD_TICKS);
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

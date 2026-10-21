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

export function legendHTML(title, levels, colors, from = 1, w = 18) {
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

const range = (a, b, step) => Array.from({ length: Math.round((b - a) / step) + 1 }, (_, i) => +(a + i * step).toFixed(1));

export const SCALES = {
  // 氣象署雨量色階(第一級改成 0.5,讓 10 分鐘雨量 0.5 mm 也看得到)
  rain: { levels: [0.5, 2, 6, 10, 15, 20, 30, 40, 50, 70, 90, 110, 130, 150, 200, 300, 400],
    colors: ['#9bffff', '#00cfff', '#0198ff', '#0165ff', '#309901', '#32ff00', '#f8ff00', '#ffcb00',
      '#ff9a00', '#fa0300', '#cc0003', '#a00000', '#98009a', '#c304cc', '#f805f3', '#fecbff'] },
  temp: { levels: [-4, ...range(0, 38, 2), 40], colors: ramp(['#2c1b8f', '#2f6bd9', '#6ec6f0', '#9be27a', '#f7e65a', '#f39a2d', '#d7301f', '#7a0177'], 21) },
  rh: { levels: range(0, 100, 10), colors: ramp(['#8c510a', '#d8b365', '#f6e8c3', '#c7eae5', '#5ab4ac', '#01665e', '#08306b'], 10) },
  pres: { levels: range(980, 1032, 4), colors: ramp(['#7a0177', '#d7301f', '#f39a2d', '#f7e65a', '#9be27a', '#6ec6f0', '#2f6bd9'], 13) },
  // 蒲福風級(m/s)
  wind: { levels: [0.3, 1.6, 3.4, 5.5, 8.0, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7, 37.0, 41.5, 46.2, 51.0, 56.1],
    colors: ramp(['#c6dbef', '#6baed6', '#41ab5d', '#d9ef8b', '#fee08b', '#fdae61', '#f46d43', '#d73027', '#a50026', '#7a0177'], 16) },
};

/** MapLibre step 運算式:值 → 顏色(低於第一級用第一色) */
export function stepExpr(scale, prop = 'v') {
  const e = ['step', ['get', prop], scale.colors[0]];
  for (let i = 1; i < scale.colors.length; i++) e.push(scale.levels[i], scale.colors[i]);
  return e;
}

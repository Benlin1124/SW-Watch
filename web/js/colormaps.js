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

export function legendHTML(title, levels, colors, from = 1) {
  const bar = colors.slice(from).map((c) => `<span style="background:${c}"></span>`).join('');
  const labels = levels.slice(from, -1).map((v) => `<span>${v}</span>`).join('');
  return `<div class="legend-title">${title}</div><div class="legend-bar">${bar}</div><div class="legend-labels">${labels}</div>`;
}

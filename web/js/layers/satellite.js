// 衛星雲圖:Himawari-9 B13 紅外線 / B07 短波紅外 / B08 水氣 / B03 可見光(pipeline/fetch_satellite.py)
// 格點在 Web Mercator 上等間距,image source 四角定位即可;畫法同雷達(uint8 → 查色表 → PNG)
import { getGrid, getIndex } from '../data.js';
import { fogCode, fogLegendHTML, fogLUT, satLegendHTML, satLUT } from '../colormaps.js';
import { latestLE } from '../time.js';
import { EMPTY_PNG, renderPNG } from './radar.js';

export const SAT_BANDS = {
  B13: { name: 'B13 紅外線', cache: 60, legend: ['亮溫 (°C)', [-85, 30], [-80, -60, -40, -20, 0, 20]] },
  B07: { name: 'B07 短波紅外', cache: 60, legend: ['亮溫 (°C)', [-80, 30], [-80, -60, -40, -20, 0, 10, 20, 30]] },
  // 組合產品:B13 − B07 亮溫差(需要 B13 和 B07 同一時次)
  FOG: { name: '夜間低雲／霧（B13−B07）', cache: 30, from: ['B13', 'B07'] },
  // 日夜:依每格太陽仰角,白天 B03 可見光、夜間 B07 短波紅外,晨昏之間漸變(時次跟 B07;夜間沒有 B03 就全用 B07)
  // 夜間冷雲頂(B13 < −30 °C)漸變改用 B13,避開 B07 低溫雜訊
  DN: { name: '日夜（B03 白天／B07 夜間）', cache: 12, from: ['B07'] },
  B08: { name: 'B08 水氣', cache: 60, legend: ['亮溫 (°C)', [-90, 0], [-80, -60, -40, -20, 0]] },
  B03: { name: 'B03 可見光', cache: 24, legend: ['反照率 (%)', [0, 100], [0, 20, 40, 60, 80, 100]] },
};

const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));

// 日夜漸變:太陽仰角 night 以下全用 B07、day 以上全用 B03(度)
// 夜間冷雲頂:B07 在低溫訊號差(顆粒雜點)→ 依 B13 亮溫,cold[0] 以上用 B07、cold[1] 以下用 B13,之間溫度線性混合(°C)
const DN = { night: 0, day: 10, cold: [-30, -50] };
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
const GRAY_LUT = Uint32Array.from({ length: 256 }, (_, v) => (v === 255 ? 0 : (0xff000000 | (v << 16) | (v << 8) | v) >>> 0));

/** 太陽赤緯與時間(NOAA 近似式,含均時差);時間取掃描開始 + 5 分(全盤掃到台灣附近約這時候) */
function sunAt(stamp) {
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
function sunElevation({ decl, min }, lat, lon) {
  const ha = (((min + 4 * lon) / 4 - 180) * Math.PI) / 180, p = (lat * Math.PI) / 180;
  return (Math.asin(Math.sin(p) * Math.sin(decl) + Math.cos(p) * Math.cos(decl) * Math.cos(ha)) * 180) / Math.PI;
}

/** 範圍內有沒有地方太陽仰角超過 DN.night(粗略取 9×9 點) */
function hasDaylight(sun, g) {
  for (let i = 0; i <= 8; i++) {
    for (let j = 0; j <= 8; j++) {
      if (sunElevation(sun, g.south + ((g.north - g.south) * i) / 8, g.west + ((g.east - g.west) * j) / 8) > DN.night) return true;
    }
  }
  return false;
}

/** 日夜合成:B03(0.01°)與 B07(0.02°)範圍相同、格點剛好兩倍 → 有 B03 時用 B03 解析度,B07 每格放大成 2×2。
 *  權重 w = 太陽仰角在 DN.night → DN.day 之間線性漸變;可見光除以 sin(仰角)補償晨昏變暗(仰角 < DN.day 時不再放大) */
async function dnCompose({ r07, r13, g07, g13 }, vis, sun) {
  const r03 = vis?.r03 ?? null, g03 = vis?.g03;
  const g = r03 ? g03 : g07, f = r03 ? 2 : 1;
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
  return { raw: { r07, r13, r03, g07, g13, g03, sun }, url: await renderPNG(code, { ...g, nodata: 255 }, GRAY_LUT) };
}

export class SatelliteLayer {
  key = 'satellite';
  name = '衛星雲圖';
  cadence = 10;
  visible = true;
  opacity = 1;
  band = 'B13';
  style = 'bd';              // B13:bd(增強)| gray
  index = null;
  indexes = {};              // band → index
  current = null;            // { key, stamp, raw }
  cache = new Map();         // `${band}|${style}|${stamp}` → Promise<{ raw, url }>(做完的 .done = true)
  dnSrc = new Map();         // 日夜下載中的來源格點:stamp → { sun, night, vis }

  constructor(map) { this.map = map; }

  get path() { return `satellite/${this.band}`; }
  get times() { return this.index?.times ?? []; }
  get latest() { return this.index?.latest ?? null; }

  /** 頻道的 index;組合產品取來源頻道共同的時次 */
  async bandIndex(band) {
    const from = SAT_BANDS[band].from;
    if (!from) return getIndex(`satellite/${band}`);
    const [a, ...rest] = await Promise.all(from.map((x) => getIndex(`satellite/${x}`)));
    const sets = rest.map((b) => new Set(b.times));
    const times = a.times.filter((t) => sets.every((s) => s.has(t)));
    return { ...a, times, latest: times[times.length - 1] ?? null };
  }

  async load() {
    this.indexes[this.band] = await this.bandIndex(this.band);
    this.index = this.indexes[this.band];
  }

  addTo(beforeId) {
    this.map.addSource('satellite', {
      type: 'image', url: EMPTY_PNG,
      coordinates: this.index?.grid?.corners ?? [[105, 35], [155, 35], [155, 5], [105, 5]],
    });
    this.map.addLayer({
      id: 'satellite', type: 'raster', source: 'satellite',
      paint: { 'raster-opacity': this.opacity, 'raster-resampling': 'linear', 'raster-fade-duration': 0 },
    }, beforeId);
  }

  /** 換頻道 / 色階;回傳 true 表示時間列表換了(時間軸要重建) */
  async configure({ band = this.band, style = this.style }) {
    const changed = band !== this.band;
    // 先等新頻道的 index 到了,再一起換 band 與 index:等待期間若有 render 呼叫 frame(),
    // 不能出現「band 已是 B07、index 還是 B13」,否則會用 B13 的 offset(−100)解讀 B07(−90),整張偏冷 10 °C 並被快取
    if (!this.indexes[band]) this.indexes[band] = await this.bandIndex(band).catch(() => null);
    Object.assign(this, { band, style, index: this.indexes[band] });
    this.current = null;
    return changed;
  }

  pick(T, sync) {
    if (!sync) return this.latest;
    return latestLE(this.times, T) === T ? T : null;
  }

  frame(stamp) {
    const { band, style } = this, key = `${band}|${style}|${stamp}`;
    if (!this.cache.has(key)) {
      const g = this.indexes[band]?.grid;              // 一定用這個頻道自己的 grid(scale / offset)
      if (!g) return Promise.reject(new Error(`satellite ${band} index 尚未載入`));
      const p = band === 'DN' ? this.dnFrame(stamp)
        : SAT_BANDS[band].from ? this.fogFrame(stamp, g)
        : getGrid(`satellite/${band}`, stamp, g).then(async (raw) => ({ raw, url: await renderPNG(raw, g, satLUT(g, band, style)) }));
      p.then(() => { p.done = true; }, () => this.cache.delete(key));
      this.cache.set(key, p);
      const max = SAT_BANDS[this.band].cache;
      while (this.cache.size > max) {
        const [k, old] = this.cache.entries().next().value;
        this.cache.delete(k);
        old.then((f) => URL.revokeObjectURL(f.url)).catch(() => {});
      }
    }
    return this.cache.get(key);
  }

  /** B13 − B07:兩個頻道格點相同(index 的 grid 一樣),逐格算差值 → 組合編碼 → 查色表 */
  async fogFrame(stamp, g) {
    const [i13, i07] = [this.indexes.B13 ?? await getIndex('satellite/B13'), await getIndex('satellite/B07')];
    const g13 = i13.grid, g07 = i07.grid;
    const [r13, r07] = await Promise.all([getGrid('satellite/B13', stamp, g13), getGrid('satellite/B07', stamp, g07)]);
    const code = new Uint8Array(r13.length);
    for (let i = 0; i < code.length; i++) {
      code[i] = r13[i] === g13.nodata || r07[i] === g07.nodata ? 255
        : fogCode(r13[i] * g13.scale + g13.offset, r07[i] * g07.scale + g07.offset);
    }
    return { raw: { r13, r07, g13, g07 }, url: await renderPNG(code, { ...g, nodata: 255 }, fogLUT()) };
  }

  /** 日夜的來源格點:B07 + B13 一組、B03 一組,同時下載(同一時次只抓一次,完整版做完就放掉);
   *  整個範圍太陽仰角都在 DN.night 以下就不抓 B03 */
  dnSources(stamp) {
    if (this.dnSrc.has(stamp)) return this.dnSrc.get(stamp);
    const idx = (b) => (this.indexes[b] ? Promise.resolve(this.indexes[b]) : getIndex(`satellite/${b}`).catch(() => null));
    const sun = sunAt(stamp);
    const night = Promise.all([idx('B07'), idx('B13')]).then(async ([i07, i13]) => {
      const [r07, r13] = await Promise.all([getGrid('satellite/B07', stamp, i07.grid),
        i13?.times.includes(stamp) ? getGrid('satellite/B13', stamp, i13.grid).catch(() => null) : null]);
      return { r07, r13, g07: i07.grid, g13: i13?.grid };
    });
    const vis = idx('B03').then((i03) => (i03?.times.includes(stamp) && hasDaylight(sun, i03.grid)
      ? getGrid('satellite/B03', stamp, i03.grid).then((r03) => ({ r03, g03: i03.grid })).catch(() => null) : null));
    const s = { sun, night, vis };
    this.dnSrc.set(stamp, s);
    return s;
  }

  /** 日夜完整版 */
  async dnFrame(stamp) {
    const s = this.dnSources(stamp);
    try {
      const [n, v] = await Promise.all([s.night, s.vis]);
      return await dnCompose(n, v, s.sun);
    } finally {
      this.dnSrc.delete(stamp);
    }
  }

  /** 日夜快速版:只用 B07 / B13(約 4 MB),B03 還沒到之前先顯示 */
  async dnQuick(stamp) {
    const s = this.dnSources(stamp);
    return dnCompose(await s.night, null, s.sun);
  }

  async show(stamp) {
    const key = `${this.band}|${this.style}|${stamp}`;
    if (stamp && this.current?.key === key && !this.current.quick) return;
    this.wanted = key;
    const src = this.map.getSource('satellite');
    if (!stamp) {
      if (!this.current) return;
      src.updateImage({ url: EMPTY_PNG, coordinates: src.coordinates });
      this.current = null;
      return;
    }
    const full = this.frame(stamp);
    // 日夜:完整版還沒好(B03 約 10 MB 下載中)→ 先放 B07 / B13 快速版
    if (this.band === 'DN' && !full.done && this.current?.key !== key) {
      const q = await this.dnQuick(stamp).catch(() => null);
      if (q && this.wanted === key && !full.done) {
        const prev = this.current?.quick;
        src.updateImage({ url: q.url, coordinates: this.index.grid.corners });
        this.current = { key, stamp, raw: q.raw, quick: q.url };
        if (prev) URL.revokeObjectURL(prev);
      } else if (q) URL.revokeObjectURL(q.url);
    }
    const f = await full;
    if (this.wanted !== key) return;
    const quick = this.current?.quick;
    src.updateImage({ url: f.url, coordinates: this.index.grid.corners });
    this.current = { key, stamp, raw: f.raw };
    if (quick) URL.revokeObjectURL(quick);
  }

  async prefetch(stamps, onProgress) {
    let done = 0;
    const queue = [...stamps];
    const worker = async () => {
      while (queue.length) {
        const s = queue.shift();
        try { await this.frame(s); } catch { /* 缺檔:播放時顯示無資料 */ }
        onProgress?.(++done, stamps.length);
      }
    };
    await Promise.all([worker(), worker()]);
  }

  setVisible(v) {
    this.visible = v;
    this.map.setLayoutProperty('satellite', 'visibility', v ? 'visible' : 'none');
  }

  setOpacity(v) {
    this.opacity = v;
    this.map.setPaintProperty('satellite', 'raster-opacity', v);
  }

  valueAt(lng, lat) {
    if (!this.current || !this.visible) return null;
    const g = this.index.grid;
    const ix = Math.floor(((lng - g.west) / (g.east - g.west)) * g.nx);
    const iy = Math.floor(((mercY(lat) - mercY(g.south)) / (mercY(g.north) - mercY(g.south))) * g.ny);
    if (ix < 0 || iy < 0 || ix >= g.nx || iy >= g.ny) return null;
    if (this.band === 'DN') {
      const { r07, r13, r03, g07, g13, g03, sun } = this.current.raw, i = iy * g.nx + ix;
      const el = sunElevation(sun, lat, lng);
      const parts = [`太陽仰角 ${el.toFixed(0)}°`];
      if (r03 && r03[iy * 2 * g03.nx + ix * 2] !== g03.nodata) parts.push(`B03 ${(r03[iy * 2 * g03.nx + ix * 2] * g03.scale + g03.offset).toFixed(0)}%`);
      if (r07[i] !== g07.nodata) parts.push(`B07 ${(r07[i] * g07.scale + g07.offset).toFixed(1)} °C`);
      if (r13 && r13[i] !== g13.nodata) parts.push(`B13 ${(r13[i] * g13.scale + g13.offset).toFixed(1)} °C`);
      return parts.join('、');
    }
    if (SAT_BANDS[this.band].from) {
      const { r13, r07, g13, g07 } = this.current.raw, i = iy * g.nx + ix;
      if (r13[i] === g13.nodata || r07[i] === g07.nodata) return null;
      const t13 = r13[i] * g13.scale + g13.offset, t07 = r07[i] * g07.scale + g07.offset;
      return `B13 ${t13.toFixed(1)} °C、B13−B07 ${(t13 - t07).toFixed(1)} °C`;
    }
    const raw = this.current.raw[iy * g.nx + ix];
    if (raw === g.nodata) return null;
    const v = raw * g.scale + g.offset;
    return this.band === 'B03' ? `反照率 ${v.toFixed(0)}%` : `${this.band} ${v.toFixed(1)} °C`;
  }

  legend() {
    if (this.band === 'FOG') return fogLegendHTML(`衛星 ${SAT_BANDS.FOG.name} 亮溫差`);
    if (this.band === 'DN') {
      const [t03, r03, k03] = SAT_BANDS.B03.legend, [t07, r07, k07] = SAT_BANDS.B07.legend;
      return satLegendHTML(`衛星 日夜：白天 B03 可見光 ${t03}`, 'B03', this.style, r03, k03)
        + satLegendHTML(`夜間 B07 短波紅外 ${t07}`, 'B07', this.style, r07, k07)
        + `<div class="legend-labels" style="margin-top:4px">太陽仰角 ${DN.night}° 以下用夜間、${DN.day}° 以上全用 B03，之間漸變；`
        + `夜間雲頂比 ${DN.cold[0]} °C 冷改用 B13（${DN.cold[1]} °C 以下全用 B13），避開 B07 低溫雜訊</div>`;
    }
    const [title, range, ticks] = SAT_BANDS[this.band].legend;
    const b13 = this.band === 'B13' ? (this.style === 'bd' ? '（增強）' : '（灰階）') : '';
    return satLegendHTML(`衛星 ${SAT_BANDS[this.band].name}${b13} ${title}`, this.band, this.style, range, ticks);
  }
}

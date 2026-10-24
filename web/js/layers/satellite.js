// 衛星雲圖:Himawari-9 B13 紅外線 / B07 短波紅外 / B08 水氣 / B03 可見光(pipeline/fetch_satellite.py)
// 格點在 Web Mercator 上等間距,image source 四角定位即可;畫法同雷達(uint8 → 查色表 → PNG)
import { getGrid, getIndex } from '../data.js';
import { fogCode, fogLegendHTML, fogLUT, satLegendHTML, satLUT } from '../colormaps.js';
import { latestLE } from '../time.js';
import { EMPTY_PNG, renderPNG } from './radar.js';

export const SAT_BANDS = {
  B13: { name: 'B13 紅外線', cache: 60, legend: ['亮溫 (°C)', [-85, 30], [-80, -60, -40, -20, 0, 20]] },
  B07: { name: 'B07 短波紅外', cache: 60, legend: ['亮溫 (°C)', [-20, 30], [-20, -10, 0, 10, 20, 30]] },
  // 組合產品:B13 − B07 亮溫差(需要 B13 和 B07 同一時次)
  FOG: { name: '夜間低雲／霧（B13−B07）', cache: 30, from: ['B13', 'B07'] },
  B08: { name: 'B08 水氣', cache: 60, legend: ['亮溫 (°C)', [-90, 0], [-80, -60, -40, -20, 0]] },
  B03: { name: 'B03 可見光', cache: 24, legend: ['反照率 (%)', [0, 100], [0, 20, 40, 60, 80, 100]] },
};

const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));

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
  cache = new Map();         // `${band}|${style}|${stamp}` → Promise<{ raw, url }>

  constructor(map) { this.map = map; }

  get path() { return `satellite/${this.band}`; }
  get times() { return this.index?.times ?? []; }
  get latest() { return this.index?.latest ?? null; }

  /** 頻道的 index;組合產品取來源頻道共同的時次 */
  async bandIndex(band) {
    const from = SAT_BANDS[band].from;
    if (!from) return getIndex(`satellite/${band}`);
    const [a, b] = await Promise.all(from.map((x) => getIndex(`satellite/${x}`)));
    const set = new Set(b.times);
    const times = a.times.filter((t) => set.has(t));
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
    Object.assign(this, { band, style });
    if (!this.indexes[band]) this.indexes[band] = await this.bandIndex(band).catch(() => null);
    this.index = this.indexes[band];
    this.current = null;
    return changed;
  }

  pick(T, sync) {
    if (!sync) return this.latest;
    return latestLE(this.times, T) === T ? T : null;
  }

  frame(stamp) {
    const key = `${this.band}|${this.style}|${stamp}`;
    if (!this.cache.has(key)) {
      const g = this.index.grid;
      const p = SAT_BANDS[this.band].from ? this.fogFrame(stamp, g)
        : getGrid(this.path, stamp, g).then(async (raw) => ({ raw, url: await renderPNG(raw, g, satLUT(g, this.band, this.style)) }));
      p.catch(() => this.cache.delete(key));
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

  async show(stamp) {
    const key = `${this.band}|${this.style}|${stamp}`;
    if (stamp && this.current?.key === key) return;
    this.wanted = key;
    const src = this.map.getSource('satellite');
    if (!stamp) {
      if (!this.current) return;
      src.updateImage({ url: EMPTY_PNG, coordinates: src.coordinates });
      this.current = null;
      return;
    }
    const f = await this.frame(stamp);
    if (this.wanted !== key) return;
    src.updateImage({ url: f.url, coordinates: this.index.grid.corners });
    this.current = { key, stamp, raw: f.raw };
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
    const [title, range, ticks] = SAT_BANDS[this.band].legend;
    const b13 = this.band === 'B13' ? (this.style === 'bd' ? '（增強）' : '（灰階）') : '';
    return satLegendHTML(`衛星 ${SAT_BANDS[this.band].name}${b13} ${title}`, this.band, this.style, range, ticks);
  }
}

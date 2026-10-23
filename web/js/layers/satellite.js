// 衛星雲圖:Himawari-9 B13 紅外線 / B08 水氣 / B03 可見光(pipeline/fetch_satellite.py)
// 格點在 Web Mercator 上等間距,image source 四角定位即可;畫法同雷達(uint8 → 查色表 → PNG)
import { getGrid, getIndex } from '../data.js';
import { satLegendHTML, satLUT } from '../colormaps.js';
import { latestLE } from '../time.js';
import { EMPTY_PNG, renderPNG } from './radar.js';

export const SAT_BANDS = {
  B13: { name: 'B13 紅外線', cache: 60, legend: ['亮溫 (°C)', [-85, 30], [-80, -60, -40, -20, 0, 20]] },
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

  async load() {
    this.indexes[this.band] = await getIndex(this.path);
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
    if (!this.indexes[band]) this.indexes[band] = await getIndex(this.path).catch(() => null);
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
      const g = this.index.grid, lut = satLUT(g, this.band, this.style);
      const p = getGrid(this.path, stamp, g).then(async (raw) => ({ raw, url: await renderPNG(raw, g, lut) }));
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
    const raw = this.current.raw[iy * g.nx + ix];
    if (raw === g.nodata) return null;
    const v = raw * g.scale + g.offset;
    return this.band === 'B03' ? `反照率 ${v.toFixed(0)}%` : `${this.band} ${v.toFixed(1)} °C`;
  }

  legend() {
    const [title, range, ticks] = SAT_BANDS[this.band].legend;
    const b13 = this.band === 'B13' ? (this.style === 'bd' ? '（增強）' : '（灰階）') : '';
    return satLegendHTML(`衛星 ${SAT_BANDS[this.band].name}${b13} ${title}`, this.band, this.style, range, ticks);
  }
}

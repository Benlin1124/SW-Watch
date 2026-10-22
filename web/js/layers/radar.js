// 雷達回波圖層:讀 uint8 格點 → 查色表畫到 canvas → PNG → MapLibre image source(用 index 的四角座標定位)
import { getGrid, getIndex } from '../data.js';
import { DBZ_COLORS, DBZ_LEVELS, legendHTML, radarLUT } from '../colormaps.js';
import { latestLE } from '../time.js';

export const EMPTY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=';
const CACHE_MAX = 200;

export async function renderPNG(raw, g, lut) {
  const canvas = document.createElement('canvas');
  canvas.width = g.nx;
  canvas.height = g.ny;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(g.nx, g.ny);
  const out = new Uint32Array(img.data.buffer);
  for (let y = 0; y < g.ny; y++) {               // 資料第 0 列在最南 → 畫到 canvas 最下面
    const src = y * g.nx, dst = (g.ny - 1 - y) * g.nx;
    for (let x = 0; x < g.nx; x++) out[dst + x] = lut[raw[src + x]];
  }
  ctx.putImageData(img, 0, 0);
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
  return URL.createObjectURL(blob);
}

export class RadarLayer {
  key = 'radar';
  name = '雷達回波';
  path = 'radar';
  cadence = 10;            // 同步模式下只顯示時間剛好相同的那一筆
  visible = true;
  opacity = 0.85;
  index = null;
  current = null;          // { stamp, raw }
  cache = new Map();       // stamp → Promise<{ raw, url }>

  constructor(map) { this.map = map; }

  get times() { return this.index?.times ?? []; }
  get latest() { return this.index?.latest ?? null; }

  async load() {
    this.index = await getIndex(this.path);
    this.lut ??= radarLUT(this.index.grid);
  }

  addTo(beforeId) {
    const g = this.index?.grid;
    this.map.addSource('radar', {
      type: 'image', url: EMPTY_PNG,
      coordinates: g?.corners ?? [[115, 29], [126.5, 29], [126.5, 18], [115, 18]],
    });
    this.map.addLayer({
      id: 'radar', type: 'raster', source: 'radar',
      paint: { 'raster-opacity': this.opacity, 'raster-resampling': 'nearest', 'raster-fade-duration': 0 },
    }, beforeId);
  }

  /** 同步:時間要剛好等於 T;不同步:最新一筆 */
  pick(T, sync) {
    if (!sync) return this.latest;
    return latestLE(this.times, T) === T ? T : null;
  }

  frame(stamp) {
    if (!this.cache.has(stamp)) {
      const g = this.index.grid;
      const p = getGrid(this.path, stamp, g).then(async (raw) => ({ raw, url: await renderPNG(raw, g, this.lut) }));
      p.catch(() => this.cache.delete(stamp));
      this.cache.set(stamp, p);
      if (this.cache.size > CACHE_MAX) {
        const [oldStamp, old] = this.cache.entries().next().value;
        this.cache.delete(oldStamp);
        old.then((f) => URL.revokeObjectURL(f.url)).catch(() => {});
      }
    }
    return this.cache.get(stamp);
  }

  async show(stamp) {
    if (stamp && this.current?.stamp === stamp) return;   // 同一張不重載(連續 updateImage 會互相中斷)
    this.wanted = stamp;
    const src = this.map.getSource('radar');
    if (!stamp) {
      if (!this.current) return;
      src.updateImage({ url: EMPTY_PNG, coordinates: this.index.grid.corners });
      this.current = null;
      return;
    }
    const f = await this.frame(stamp);
    if (this.wanted !== stamp) return;          // 使用者已經切到別的時間
    src.updateImage({ url: f.url, coordinates: this.index.grid.corners });
    this.current = { stamp, raw: f.raw };
  }

  async prefetch(stamps, onProgress) {
    let done = 0;
    const queue = [...stamps];
    const worker = async () => {
      while (queue.length) {
        const s = queue.shift();
        try { await this.frame(s); } catch { /* 缺檔就算了,播放時顯示無資料 */ }
        onProgress?.(++done, stamps.length);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  }

  setVisible(v) {
    this.visible = v;
    this.map.setLayoutProperty('radar', 'visibility', v ? 'visible' : 'none');
  }

  setOpacity(v) {
    this.opacity = v;
    this.map.setPaintProperty('radar', 'raster-opacity', v);
  }

  /** 游標位置的 dBZ;四角近似為矩形(TWD67 位移在範圍內差異 < 1/15 格) */
  valueAt(lng, lat) {
    if (!this.current || !this.visible) return null;
    const g = this.index.grid, [tl, tr, br, bl] = g.corners;
    const west = (tl[0] + bl[0]) / 2, east = (tr[0] + br[0]) / 2;
    const north = (tl[1] + tr[1]) / 2, south = (bl[1] + br[1]) / 2;
    const ix = Math.floor(((lng - west) / (east - west)) * g.nx);
    const iy = Math.floor(((lat - south) / (north - south)) * g.ny);
    if (ix < 0 || iy < 0 || ix >= g.nx || iy >= g.ny) return null;
    const raw = this.current.raw[iy * g.nx + ix];
    if (raw === g.nodata) return '雷達範圍外';
    if (raw === 0) return '無回波';
    return `${(raw * g.scale + g.offset).toFixed(1)} dBZ`;
  }

  legend() { return legendHTML('雷達回波 (dBZ)', DBZ_LEVELS, DBZ_COLORS); }
}

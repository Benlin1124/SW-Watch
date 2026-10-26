// 衛星雲圖:Himawari-9 B13 紅外線 / B07 短波紅外 / B08 水氣 / B03 可見光(pipeline/fetch_satellite.py)
// 格點在 Web Mercator 上等間距,image source 四角定位即可;畫法同雷達(uint8 → 查色表 → PNG)
import { getGrid, getIndex } from '../data.js';
import { fogCode, fogLegendHTML, fogLUT, satLegendHTML, satLUT } from '../colormaps.js';
import { latestLE } from '../time.js';
import { EMPTY_PNG, renderPNG } from './radar.js';
import { DN, hasDaylight, mercY, sunAt, sunElevation } from './daynight.js';

export const SAT_BANDS = {
  B13: { name: 'B13 紅外線', cache: 60, legend: ['亮溫 (°C)', [-85, 30], [-80, -60, -40, -20, 0, 20]] },
  B07: { name: 'B07 短波紅外', cache: 60, legend: ['亮溫 (°C)', [-80, 30], [-80, -60, -40, -20, 0, 10, 20, 30]] },
  // 組合產品:B13 − B07 亮溫差(需要 B13 和 B07 同一時次)
  FOG: { name: '夜間低雲／霧（B13−B07）', cache: 30, from: ['B13', 'B07'] },
  // 日夜:依每格太陽仰角,白天 B03 可見光、夜間 B07 短波紅外,晨昏之間漸變(時次跟 B07;夜間沒有 B03 就全用 B07)
  // 夜間冷雲頂(B13 < −30 °C)漸變改用 B13,避開 B07 低溫雜訊
  DN: { name: '日夜（B03 白天／B07 夜間）', cache: 24, from: ['B07'] },
  B08: { name: 'B08 水氣', cache: 60, legend: ['亮溫 (°C)', [-90, 0], [-80, -60, -40, -20, 0]] },
  B03: { name: 'B03 可見光', cache: 24, legend: ['反照率 (%)', [0, 100], [0, 20, 40, 60, 80, 100]] },
};

// 日夜合成交給背景 worker(daynight-worker.js);r07 / r13 留著給滑鼠讀值所以複製過去,B03 原檔用完就丟(轉移)
let worker = null, jobId = 0;
const jobs = new Map();
function dnCompose(night, vis, sun) {
  if (!worker) {
    worker = new Worker(new URL('./daynight-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      const job = jobs.get(data.id);
      jobs.delete(data.id);
      if (data.error) job.reject(new Error(data.error));
      else job.resolve(data);
    };
  }
  const id = ++jobId;
  return new Promise((resolve, reject) => {
    jobs.set(id, { resolve, reject });
    worker.postMessage({ id, night, vis, sun }, vis ? [vis.r03.buffer] : []);
  }).then(async ({ rgba, nx, ny, r03s }) => ({
    raw: { ...night, r03: r03s, g03: vis?.g03, sun },
    url: await rgbaJPEG(rgba, nx, ny),
  }));
}

/** 像素 → JPEG blob URL(編碼在瀏覽器背景做)。
 *  不用 PNG:日夜雲圖細節多,PNG 一張約 18 MB、編碼約 1 秒,快取多張會塞滿瀏覽器 blob 記憶體;JPEG 約 1/10 大。
 *  JPEG 不透明:缺值畫成黑色(範圍都在全盤內,幾乎沒有缺值) */
async function rgbaJPEG(rgba, nx, ny) {
  const canvas = document.createElement('canvas');
  canvas.width = nx;
  canvas.height = ny;
  canvas.getContext('2d').putImageData(new ImageData(rgba, nx, ny), 0, 0);
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.92));
  canvas.width = canvas.height = 0;             // 立刻放掉畫布記憶體
  return URL.createObjectURL(blob);
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
  onLoading = null;          // (stamp | null):這個時間還在下載 / 合成(畫面先維持上一張)

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
    // 還沒做好(日夜白天要等 B03 約 10 MB)→ 畫面維持上一張,圖層時間欄標「載入中」(使用者不要先顯示 B07 的快速版)
    const p = this.frame(stamp);
    if (!p.done) this.onLoading?.(stamp);
    let f;
    try {
      f = await p;
    } finally {
      if (this.wanted === key) this.onLoading?.(null);
    }
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
    if (this.band === 'DN') {
      const { r07, r13, r03, g07, g13, g03, sun } = this.current.raw, i = iy * g.nx + ix;
      const el = sunElevation(sun, lat, lng);
      const parts = [`太陽仰角 ${el.toFixed(0)}°`];
      if (r03 && r03[i] !== g03.nodata) parts.push(`B03 ${(r03[i] * g03.scale + g03.offset).toFixed(0)}%`);   // r03 已縮成 B07 格點
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

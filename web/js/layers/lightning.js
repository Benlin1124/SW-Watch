// 即時閃電(氣象署 O-A0039-001;pipeline/fetch_lightning.py):每 10 分鐘一格的 JSON,每筆 [經度, 緯度, 格內第幾分, 0 雲間 / 1 對地]。
// 顯示「結尾時間往前 N 分鐘」內的閃電:對地 = 十字、雲間 = 小圓點,顏色依距結尾幾分鐘(越新越紅)。
// 同步:結尾 = 時間軸的時間 T(含 T 那一分鐘,和雷達同一刻);不同步:結尾 = 來源最新一分鐘。
import { getIndex, getJSON } from '../data.js';
import { addMin, diffMin, floorStep, latestLE } from '../time.js';

const EMPTY = { type: 'FeatureCollection', features: [] };
const CACHE_MAX = 300;
// 距結尾幾分鐘 → 顏色(上限,含)
export const LT_AGES = [5, 10, 20, 30, 60];
export const LT_COLORS = ['#ff1744', '#ff9100', '#ffea00', '#00e676', '#40c4ff'];
const IDS = ['lt-cloud', 'lt-ground'];

/** 十字的 SDF 圖(icon-color 可換色、icon-halo 描邊) */
function crossImage() {
  const s = 32, arm = 11, half = 2.6, buf = 8, out = new ImageData(s, s);
  const c = s / 2;
  // 到「兩個長方形聯集」的帶號距離
  const box = (x, y, hx, hy) => {
    const dx = Math.abs(x) - hx, dy = Math.abs(y) - hy;
    return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0);
  };
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const px = x + 0.5 - c, py = y + 0.5 - c;
    const d = Math.min(box(px, py, arm, half), box(px, py, half, arm));
    out.data[(y * s + x) * 4 + 3] = Math.round(255 * Math.max(0, Math.min(1, 0.75 - d / buf)));
  }
  return out;
}

export class LightningLayer {
  key = 'lightning';
  name = '即時閃電';
  path = 'lightning';
  cadence = null;            // 不限制播放結尾
  staleMin = 15;
  visible = false;
  opacity = 1;
  window = 30;               // 顯示結尾往前幾分鐘
  index = null;
  cache = new Map();         // 格 → Promise<rows>
  current = null;            // { key, rows: [[lon, lat, age, kind]] }

  constructor(map) { this.map = map; }

  get times() { return this.index?.times ?? []; }
  /** 來源最新一分鐘 */
  get latest() { return this.index?.end ? addMin(this.index.end, -1) : null; }

  async load() { this.index = await getIndex(this.path); }

  addTo(beforeId) {
    const m = this.map;
    if (!m.hasImage('lt-cross')) m.addImage('lt-cross', crossImage(), { sdf: true });
    m.addSource('lightning', { type: 'geojson', data: EMPTY });
    const color = ['step', ['get', 'age'], LT_COLORS[0], ...LT_AGES.slice(0, -1).flatMap((a, i) => [a, LT_COLORS[i + 1]])];
    const vis = this.visible ? 'visible' : 'none';
    m.addLayer({ id: 'lt-cloud', type: 'circle', source: 'lightning', filter: ['==', ['get', 'k'], 0],
      layout: { visibility: vis },
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 1.6, 9, 3, 12, 4.5], 'circle-color': color,
        'circle-stroke-color': '#222', 'circle-stroke-width': 0.6, 'circle-opacity': this.opacity, 'circle-stroke-opacity': this.opacity } }, beforeId);
    m.addLayer({ id: 'lt-ground', type: 'symbol', source: 'lightning', filter: ['==', ['get', 'k'], 1],
      layout: { visibility: vis, 'icon-image': 'lt-cross', 'icon-allow-overlap': true, 'icon-ignore-placement': true,
        'icon-size': ['interpolate', ['linear'], ['zoom'], 5, 0.28, 9, 0.42, 12, 0.65],
        'symbol-sort-key': ['-', ['get', 'age']] },          // 新的畫在上面
      paint: { 'icon-color': color, 'icon-halo-color': '#222', 'icon-halo-width': 1, 'icon-opacity': this.opacity } }, beforeId);
  }

  /** 結尾時間:同步 = T(來源要涵蓋到 T);不同步 = 來源最新一分鐘 */
  pick(T, sync) {
    if (!sync) return this.latest;
    const end = this.index?.end;
    return end && T < end && latestLE(this.times, T) === floorStep(T) ? T : null;
  }

  /** 結尾 E 需要的格 */
  slotsFor(E) {
    const out = [];
    for (let s = floorStep(addMin(E, -this.window + 1)); s <= E; s = addMin(s, 10)) if (this.times.includes(s)) out.push(s);
    return out;
  }

  framesFor(frames) { return [...new Set(frames.flatMap((T) => this.slotsFor(T)))]; }

  slot(stamp) {
    if (!this.cache.has(stamp)) {
      // 最新那格會一直補資料 → 加時間參數避免快取
      const fresh = this.index?.end && diffMin(this.index.end, stamp) <= 10;
      const p = getJSON(`${this.path}/${stamp}.json${fresh ? `?t=${this.index.updated}` : ''}`).then((d) => d.s);
      p.catch(() => this.cache.delete(stamp));
      this.cache.set(stamp, p);
      if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value);
    }
    return this.cache.get(stamp);
  }

  async prefetch(stamps, onProgress) {
    let done = 0;
    const queue = [...stamps];
    const worker = async () => {
      while (queue.length) {
        try { await this.slot(queue.shift()); } catch { /* 缺檔 */ }
        onProgress?.(++done, stamps.length);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  }

  async show(E) {
    const key = E && `${E}|${this.window}|${this.index?.updated}`;
    if (key && this.current?.key === key) return;
    this.wanted = key;
    const src = this.map.getSource('lightning');
    if (!E) {
      if (this.current) src.setData(EMPTY);
      this.current = null;
      return;
    }
    const slots = this.slotsFor(E);
    const parts = await Promise.all(slots.map((s) => this.slot(s).catch(() => [])));
    if (this.wanted !== key) return;
    const rows = [];
    slots.forEach((s, i) => {
      const base = diffMin(E, s);
      for (const [lon, lat, m, k] of parts[i]) {
        const age = base - m;                    // 距結尾幾分鐘(0 = 結尾那一分)
        if (age >= 0 && age < this.window) rows.push([lon, lat, age, k]);
      }
    });
    src.setData({ type: 'FeatureCollection', features: rows.map(([lon, lat, age, k]) => ({
      type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { age, k } })) });
    this.current = { key, rows };
  }

  setVisible(v) {
    this.visible = v;
    for (const id of IDS) if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', v ? 'visible' : 'none');
  }

  setWindow(min) { this.window = min; }

  setOpacity(v) {
    this.opacity = v;
    if (!this.map.getLayer('lt-cloud')) return;
    this.map.setPaintProperty('lt-cloud', 'circle-opacity', v);
    this.map.setPaintProperty('lt-cloud', 'circle-stroke-opacity', v);
    this.map.setPaintProperty('lt-ground', 'icon-opacity', v);
  }

  /** 游標附近 5 公里內的閃電次數 */
  valueAt(lng, lat) {
    if (!this.visible || !this.current) return null;
    const kx = Math.cos((lat * Math.PI) / 180) * 111.2, ky = 111.2;
    let n = 0, g = 0;
    for (const [x, y, , k] of this.current.rows) {
      if (Math.hypot((x - lng) * kx, (y - lat) * ky) <= 5) { n++; g += k; }
    }
    return n ? `閃電 ${n} 次（5 km 內，對地 ${g}）` : null;
  }

  legend() {
    const sw = LT_COLORS.map((c, i) => `<span class="lt-age"><i style="background:${c}"></i>${i ? LT_AGES[i - 1] : 0}–${LT_AGES[i]}</span>`)
      .filter((_, i) => (i ? LT_AGES[i - 1] : 0) < this.window).join('');
    return `<div class="legend-title">即時閃電（距結尾分鐘）</div><div class="lt-legend">${sw}</div>`
      + '<div class="lt-legend"><span class="lt-age"><b>＋</b>對地</span><span class="lt-age"><b>●</b>雲間</span></div>';
  }
}

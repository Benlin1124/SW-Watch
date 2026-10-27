// ECMWF IFS 預報(台灣附近,pipeline/fetch_ecmwf.py):降雨、溫度、海平面氣壓、平均風、陣風、浪高、尖峰週期
// 每個起報、每個變數一個檔(全部預報時刻);換時刻不用再下載。
// 格點是經緯度等間距,畫到 canvas 時每列換算成 Web Mercator 位置,並放大 4 倍做雙線性內插再上色
import { DATA_BASE_URL } from '../config.js';
import { getIndex } from '../data.js';
import { beaufortLegendHTML, legendHTML, SCALES, withInfo } from '../colormaps.js';
import { addMin, fmtTW } from '../time.js';
import { EMPTY_PNG } from './radar.js';
import { arrowImage } from './stations.js';
import { waveClass, WAVE_CLASSES } from './marine.js';

export const EC_VARS = {
  rain: { name: '降雨', unit: 'mm' },
  t2: { name: '溫度', unit: '°C' },
  msl: { name: '海平面氣壓', unit: 'hPa' },
  wind: { name: '平均風', unit: 'm/s' },
  gust: { name: '陣風', unit: 'm/s' },
  swh: { name: '浪高', unit: 'm' },
  pp1d: { name: '尖峰週期', unit: 's' },
};
export const RAIN_WINDOWS = { 3: '3 小時', 6: '6 小時', 12: '12 小時', 24: '24 小時', 0: '起報後累積' };

const UP = 8;                      // 畫圖放大倍數(色塊邊界才不會有鋸齒)
const ARROW_EVERY = 1;             // 每格(0.1°)都放風向箭頭,重疊的由地圖自動略過 → 放大越密
const CACHE_MAX = 24;
const FRAMES_MAX = 60;             // 畫好的圖最多留幾張(一報 29 個時刻,夠播兩個變數)
const EMPTY = { type: 'FeatureCollection', features: [] };
const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const latOf = (y) => (Math.atan(Math.exp(y)) * 360) / Math.PI - 90;
const WAVE_NOTE = '示性波高、尖峰週期：ECMWF 海浪模式（0.1°，近岸與港內沒有值）；箭頭 = 浪前進方向。';
export const fmtEcInit = (s) => `${s.slice(4, 6)}/${s.slice(6, 8)} ${s.slice(8, 10)}Z`;

function packHex(hex) {
  const n = parseInt(hex.slice(1, 7), 16);
  return ((255 << 24) | ((n & 255) << 16) | (n & 0xff00) | ((n >> 16) & 255)) >>> 0;
}

export class EcmwfLayer {
  key = 'ecmwf';
  name = 'ECMWF 預報';
  path = 'ecmwf';
  cadence = null;
  visible = false;
  opacity = 0.8;
  index = null;
  init = '';                 // '' = 最新一報
  step = null;               // 預報時距(小時);null = 自動選最接近現在的
  variable = 'rain';
  rainHours = 3;
  follow = false;            // 對齊時間軸:預報時刻跟著時間軸 T
  showArrows = true;         // 風 / 浪的方向箭頭
  shown = null;              // { key, init, step, field, label }
  cache = new Map();         // `${init}/${var}` → Promise<Uint16Array>
  frames = new Map();        // key → Promise<畫好的圖>

  constructor(map) { this.map = map; }

  get times() { return []; }                 // 不參與時間軸(預報時間在未來)
  get latest() { return this.index?.latest ?? null; }
  get inits() { return [...(this.index?.times ?? [])].reverse(); }
  get activeInit() { return this.inits.includes(this.init) ? this.init : this.latest; }
  get steps() { return this.index?.steps ?? []; }

  async load() {
    this.index = await getIndex(this.path);
  }

  addTo(beforeId) {
    const m = this.map;
    if (!m.hasImage('st-arrow')) m.addImage('st-arrow', arrowImage(), { sdf: true });
    m.addSource('ecmwf', { type: 'image', url: EMPTY_PNG, coordinates: this.corners() ?? [[115, 28], [130, 28], [130, 17], [115, 17]] });
    m.addLayer({ id: 'ecmwf', type: 'raster', source: 'ecmwf', layout: { visibility: this.visible ? 'visible' : 'none' },
      paint: { 'raster-opacity': this.opacity, 'raster-resampling': 'linear', 'raster-fade-duration': 0 } }, beforeId);
    m.addSource('ecmwf-arrows', { type: 'geojson', data: EMPTY });
    m.addLayer({ id: 'ecmwf-arrows', type: 'symbol', source: 'ecmwf-arrows', layout: {
      visibility: this.visible && this.showArrows ? 'visible' : 'none',
      'icon-image': 'st-arrow', 'icon-rotate': ['get', 'dir'], 'icon-rotation-alignment': 'map',
      'icon-allow-overlap': false, 'icon-padding': 0,
      'icon-size': ['interpolate', ['linear'], ['zoom'], 5, 0.3, 8, 0.45, 11, 0.6] },
    paint: { 'icon-color': '#263238', 'icon-halo-color': '#ffffff', 'icon-halo-width': 1, 'icon-opacity': this.opacity } }, beforeId);
  }

  corners() {
    const g = this.index?.grid;
    return g && [[g.west, g.north], [g.east, g.north], [g.east, g.south], [g.west, g.south]];
  }

  validOf(init, step) { return addMin(init, step * 60); }

  /** 對齊時間軸:時間軸 T 之前(含)最近的預報時刻 */
  stepAt(init, T) {
    let best = null;
    for (const s of this.steps) if (this.validOf(init, s) <= T) best = s;
    return best;
  }

  /** 沒指定時,選最接近現在(含之後)的時刻 */
  defaultStep(init) {
    const now = new Date().toISOString().replace(/\D/g, '').slice(0, 12);
    return this.steps.find((s) => this.validOf(init, s) >= now) ?? this.steps[this.steps.length - 1] ?? 0;
  }

  pick(T) {
    const init = this.activeInit;
    if (!init || !this.visible) return null;
    let step = this.follow && T ? this.stepAt(init, T) : (this.step ?? this.defaultStep(init));
    if (step == null) return null;
    if (!this.steps.includes(step)) step = this.defaultStep(init);
    this.pickedStep = step;
    return `${init}|${step}|${this.variable}|${this.rainHours}`;
  }

  data(init, v) {
    const key = `${init}/${v}`;
    if (!this.cache.has(key)) {
      const spec = this.index.vars[v];
      const p = fetch(new URL(`${this.path}/${init}/${v}.bin.gz`, DATA_BASE_URL).href)
        .then((r) => { if (!r.ok) throw new Error(`${key} ${r.status}`); return r.arrayBuffer(); })
        .then(gunzip)
        .then((buf) => ({ raw: new Uint16Array(buf), spec }));
      p.catch(() => this.cache.delete(key));
      this.cache.set(key, p);
      while (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value);
    }
    return this.cache.get(key);
  }

  /** 第 k 步的實際值(Float32,NaN = 無資料) */
  async slice(init, v, k) {
    const { raw, spec } = await this.data(init, v);
    const n = this.index.grid.nx * this.index.grid.ny, out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const r = raw[k * n + i];
      out[i] = r === spec.nodata ? NaN : r * spec.scale + spec.offset;
    }
    return out;
  }

  /** 目前選的變數在第 step 小時的場;回傳 { field, u, v, label } */
  async field(init, step, variable, rainHours) {
    const k = this.steps.indexOf(step);
    if (variable === 'rain') {
      const w = rainHours || step;                  // 0 = 起報後累積
      const from = Math.max(step - w, 0), k0 = this.steps.indexOf(from);
      const a = await this.slice(init, 'tp', k);
      if (from > 0) {
        const b = await this.slice(init, 'tp', k0);
        for (let i = 0; i < a.length; i++) a[i] = Math.max(a[i] - b[i], 0);
      }
      const span = step - from;
      const label = rainHours && span < rainHours ? `起報後 ${span} 小時雨量` : rainHours ? `${span} 小時雨量` : `起報後累積雨量（${step} 小時）`;
      return { field: a, label };
    }
    if (variable === 'wind' || variable === 'gust') {
      const [u, v] = await Promise.all([this.slice(init, 'u10', k), this.slice(init, 'v10', k)]);
      const f = variable === 'gust' ? await this.slice(init, 'gust', k) : u.map((x, i) => Math.hypot(x, v[i]));
      return { field: f, u, v, label: variable === 'gust' ? '陣風（該時刻前 1 小時最大）' : '10 m 平均風' };
    }
    if (variable === 'swh' || variable === 'pp1d') {     // 海浪:箭頭畫浪前進方向(mwd 是來向,轉 180°)
      const [f, d] = await Promise.all([this.slice(init, variable, k), this.slice(init, 'mwd', k)]);
      const rad = d.map((x) => ((x + 180) * Math.PI) / 180);
      return { field: f, u: rad.map(Math.sin), v: rad.map(Math.cos), label: variable === 'swh' ? '示性波高' : '尖峰週期' };
    }
    return { field: await this.slice(init, variable, k), label: EC_VARS[variable].name };
  }

  scale(variable) {
    if (variable === 'rain') return SCALES.rain;             // 各時段同一套(氣象署,≥ 300 最後一色)
    if (variable === 't2') return SCALES.temp;
    if (variable === 'msl') return SCALES.pres;
    if (variable === 'swh') return SCALES.wave;
    if (variable === 'pp1d') return SCALES.period;
    return SCALES.wind;
  }

  async render(f, sc) {
    const g = this.index.grid, W = g.nx * UP, H = g.ny * UP;
    const packed = sc.colors.map(packHex);
    const color = (x) => {
      if (Number.isNaN(x) || (sc.min != null && x < sc.min)) return 0;
      let i = 0;
      while (i + 1 < packed.length && x >= sc.levels[i + 1]) i++;
      return packed[i];
    };
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d'), img = ctx.createImageData(W, H), out = new Uint32Array(img.data.buffer);
    const yN = mercY(g.north), yS = mercY(g.south);
    for (let py = 0; py < H; py++) {
      const lat = latOf(yN - ((py + 0.5) / H) * (yN - yS));       // 這一列在 Mercator 上的緯度
      const fy = Math.min(Math.max((lat - g.lat0) / g.dy, 0), g.ny - 1);
      const y0 = Math.floor(fy), y1 = Math.min(y0 + 1, g.ny - 1), ty = fy - y0;
      for (let px = 0; px < W; px++) {
        const fx = Math.min(Math.max((px + 0.5) / UP - 0.5, 0), g.nx - 1);
        const x0 = Math.floor(fx), x1 = Math.min(x0 + 1, g.nx - 1), tx = fx - x0;
        const a = f[y0 * g.nx + x0], b = f[y0 * g.nx + x1], c = f[y1 * g.nx + x0], d = f[y1 * g.nx + x1];
        const v = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
        out[py * W + px] = color(v);
      }
    }
    ctx.putImageData(img, 0, 0);
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    return URL.createObjectURL(blob);
  }

  arrows(u, v) {
    const g = this.index.grid, features = [];
    for (let y = 0; y < g.ny; y += ARROW_EVERY) {
      for (let x = 0; x < g.nx; x += ARROW_EVERY) {
        const i = y * g.nx + x, uu = u[i], vv = v[i];
        if (Number.isNaN(uu) || Number.isNaN(vv)) continue;
        features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [g.lon0 + x * g.dx, g.lat0 + y * g.dy] },
          properties: { dir: (Math.atan2(uu, vv) * 180) / Math.PI, ws: Math.hypot(uu, vv) } });   // 風吹向的方向
      }
    }
    return { type: 'FeatureCollection', features };
  }

  async show(key) {
    if (key && this.shown?.key === key) return;
    this.wanted = key;
    const src = this.map.getSource('ecmwf'), arr = this.map.getSource('ecmwf-arrows');
    if (!key) {
      if (!this.shown) return;
      src.updateImage({ url: EMPTY_PNG, coordinates: this.corners() });
      arr.setData(EMPTY);
      this.shown = null;
      return;
    }
    const f = await this.frame(key);
    if (this.wanted !== key) return;
    src.updateImage({ url: f.url, coordinates: this.corners() });
    arr.setData(f.arrows);
    this.shown = { key, ...f };
  }

  /** 一張畫好的圖(場、色階、PNG、箭頭);留著給播放重複用 */
  frame(key) {
    if (!this.frames.has(key)) {
      const [init, s, variable, rh] = key.split('|'), step = +s;
      const p = (async () => {
        const r = await this.field(init, step, variable, +rh);
        const sc = this.scale(variable);
        return { init, step, variable, field: r.field, label: r.label, sc, url: await this.render(r.field, sc),
          arrows: r.u ? this.arrows(r.u, r.v) : EMPTY };
      })();
      p.catch(() => this.frames.delete(key));
      this.frames.set(key, p);
      while (this.frames.size > FRAMES_MAX) {
        const [k, old] = this.frames.entries().next().value;
        if (k === this.shown?.key) { this.frames.delete(k); this.frames.set(k, old); continue; }
        this.frames.delete(k);
        old.then((x) => URL.revokeObjectURL(x.url)).catch(() => {});
      }
    }
    return this.frames.get(key);
  }

  /** 播放前先把整段畫好(目前的初始、變數),回報進度 */
  async prefetch(onProgress) {
    const init = this.activeInit, keys = this.steps.map((s) => `${init}|${s}|${this.variable}|${this.rainHours}`);
    let done = 0;
    for (const k of keys) {
      try { await this.frame(k); } catch { /* 缺檔:播放時跳過 */ }
      onProgress?.(++done, keys.length);
    }
  }

  timeLabel() {
    if (!this.shown) return null;
    const { init, step } = this.shown;
    return { text: `${fmtTW(this.validOf(init, step))}（${fmtEcInit(init)} +${step}h）` };
  }

  setVisible(v) {
    this.visible = v;
    this.map.setLayoutProperty('ecmwf', 'visibility', v ? 'visible' : 'none');
    this.map.setLayoutProperty('ecmwf-arrows', 'visibility', v && this.showArrows ? 'visible' : 'none');
  }

  setArrows(on) {
    this.showArrows = on;
    this.map.setLayoutProperty('ecmwf-arrows', 'visibility', this.visible && on ? 'visible' : 'none');
  }

  setOpacity(v) {
    this.opacity = v;
    this.map.setPaintProperty('ecmwf', 'raster-opacity', v);
    this.map.setPaintProperty('ecmwf-arrows', 'icon-opacity', v);
  }

  valueAt(lng, lat) {
    if (!this.shown || !this.visible) return null;
    const g = this.index.grid;
    const ix = Math.round((lng - g.lon0) / g.dx), iy = Math.round((lat - g.lat0) / g.dy);
    if (ix < 0 || iy < 0 || ix >= g.nx || iy >= g.ny) return null;
    const x = this.shown.field[iy * g.nx + ix];
    if (Number.isNaN(x)) return null;
    const v = this.shown.variable, unit = EC_VARS[v].unit;
    const cls = v === 'swh' && waveClass(x) ? `（${waveClass(x)}）` : '';
    return `ECMWF ${EC_VARS[v].name} ${x.toFixed(1)} ${unit}${cls}`;
  }

  legend() {
    if (!this.shown) return `<div class="legend-title">ECMWF 預報（無資料）</div>`;
    const { variable, sc, label, init, step } = this.shown;
    const title = `ECMWF ${label}（${fmtEcInit(init)} +${step}h）`;
    if (variable === 'wind' || variable === 'gust') return beaufortLegendHTML(`${title}（蒲福風級）`, sc.colors);
    const html = legendHTML(`${title} (${EC_VARS[variable].unit})`, sc.levels, sc.colors, 0, 22, sc.ticks);
    if (variable === 'swh') {
      const cls = WAVE_CLASSES.map(([lo, name], i) => `${name} ${lo}${WAVE_CLASSES[i + 1] ? `–${WAVE_CLASSES[i + 1][0]}` : ' 以上'}`);
      return `${withInfo(html, WAVE_NOTE)}<div class="legend-labels" style="margin-top:4px">${cls.join('｜')} m</div>`;
    }
    return variable === 'pp1d' ? withInfo(html, WAVE_NOTE) : html;
  }
}

/** 檔案是 gzip;伺服器若已解壓就直接用(同 data.js) */
async function gunzip(buf) {
  const u8 = new Uint8Array(buf);
  if (u8[0] !== 0x1f || u8[1] !== 0x8b) return buf;
  const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

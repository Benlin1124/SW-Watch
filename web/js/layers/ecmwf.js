// 模式預報圖層,可切換模式:
//   ecmwf:ECMWF IFS(90–180°E、0–50°N)、每 3 小時(pipeline/fetch_ecmwf.py):降雨、溫度、海平面氣壓、平均風、陣風、浪高、尖峰 / 平均週期
//     拉遠用 0.25° 全範圍一個檔;放大(FINE_ZOOM 以上、畫面內不超過 FINE_MAX_TILES 塊)只下載看得到的 0.1° 分塊(10°×10°)拼起來
//   aifs:ECMWF AIFS(AI 模式)0.25°(90–180°E、0–50°N)、每 6 小時(pipeline/fetch_aifs.py):降雨、溫度、海平面氣壓、平均風、浪高、平均週期
//   wrf:氣象署 WRF 3 km(重新內插成 0.03°)、每 6 小時(pipeline/fetch_wrf.py):降雨、溫度、海平面氣壓、平均風
//   cwawave:氣象署海浪模式 0.1°、逐時到 168 小時(pipeline/fetch_cwa_wave.py):浪高、平均週期(浪向畫箭頭)
// 檔案格式相同:每個起報、每個變數一個檔(全部預報時刻;IFS 0.1° 是每塊一個檔);換時刻不用再下載。
// 範圍改大(2026-10-29)前的舊報:index grids[起報] = 它自己的 grid(台灣附近),沒有分塊。
// 格點是經緯度等間距,畫到 canvas 時每列換算成 Web Mercator 位置,並放大(約 0.0125° 一像素)做雙線性內插再上色
// 海浪(浪高、週期、波向):陸地沒值 → 往陸地外推 FILL_ITERS 格,畫完再用底圖陸地挖掉(海岸不再是方塊鋸齒)
import { DATA_BASE_URL } from '../config.js';
import { getIndex } from '../data.js';
import { landMask } from '../land.js';
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
  mwp: { name: '平均週期', unit: 's' },
};
export const MODELS = {
  ecmwf: { name: 'ECMWF IFS', path: 'ecmwf', vars: ['rain', 't2', 'msl', 'wind', 'gust', 'swh', 'pp1d', 'mwp'] },
  aifs: { name: 'ECMWF AIFS', path: 'aifs', vars: ['rain', 't2', 'msl', 'wind', 'swh', 'mwp'] },
  wrf: { name: '氣象署 3km', path: 'wrf', vars: ['rain', 't2', 'msl', 'wind'] },
  cwawave: { name: '氣象署海浪', path: 'cwawave', vars: ['swh', 'mwp'] },
};
export const RAIN_WINDOWS = { 3: '3 小時', 6: '6 小時', 12: '12 小時', 24: '24 小時', 0: '起報後累積' };

const PX_DEG = 0.0125;              // 畫圖每像素約幾度(ECMWF 放大 8 倍、3 km 放大 2 倍;色塊邊界才不會有鋸齒)
const MAX_PX = 2400;               // 畫布長邊上限(大範圍時放大倍數跟著降)
const ARROW_DEG = 0.1;             // 箭頭間距約 0.1°,重疊的由地圖自動略過 → 放大越密
const ARROWS_MAX = 6000;           // 箭頭最多幾個(大範圍時間距跟著放大)
const FINE_ZOOM = 5.5;             // 縮放到這以上改用 0.1° 分塊
const FINE_MAX_TILES = 12;         // 畫面內超過這麼多塊就還是用 0.25°
const CACHE_MAX = 96;              // 下載的檔(分塊一個約 1 MB 解開後)
const FRAMES_MAX = 60;             // 畫好的圖最多留幾張(ECMWF 一報 29 個時刻,夠播兩個變數)
const EMPTY = { type: 'FeatureCollection', features: [] };
const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const latOf = (y) => (Math.atan(Math.exp(y)) * 360) / Math.PI - 90;
const WAVE_VARS = new Set(['swh', 'mwd', 'pp1d', 'mwp']);
const FILL_ITERS = 3;              // 海浪往陸地外推幾格(0.1° 一格)
const COAST_NOTE = '模式在近岸約 10 公里內沒有值，這段用外海的值往岸邊外推、再依底圖海岸線裁切，'
  + '只是讓圖連到海岸，不是真的近岸浪況（點擊查值會標「近岸外推」）。港內、海灣沒有值。';
const WAVE_NOTE = {
  ecmwf: `示性波高、尖峰週期、平均週期：ECMWF 海浪模式（放大 0.1°、拉遠 0.25°，每 3 小時）；箭頭 = 浪前進方向。`
    + `尖峰週期 = 能量最大的波的週期；平均週期較短，可和氣象署海浪比較（2026-10-28 下午起的起報才有）。${COAST_NOTE}`,
  aifs: `浪高、平均週期：ECMWF AIFS 海浪（0.25°，每 6 小時；開放資料沒有尖峰週期）；箭頭 = 浪前進方向。${COAST_NOTE}`,
  cwawave: '浪高、平均週期：氣象署海浪模式（0.1°，逐時到 7 天，只到 126°E）；箭頭 = 浪前進方向。'
    + `檔案的欄位說明是亂碼，週期和 ECMWF 比對後判斷是平均週期（比尖峰週期短）。${COAST_NOTE}`,
};
export const fmtEcInit = (s) => `${s.slice(4, 6)}/${s.slice(6, 8)} ${s.slice(8, 10)}Z`;

/** 0.1° 分塊 (i0..i1, j0..j1) 拼起來的格點(相鄰塊共用邊) */
function tileGrid(fine, r) {
  const s = fine.n - 1, d = fine.dx;
  const nx = (r.i1 - r.i0 + 1) * s + 1, ny = (r.j1 - r.j0 + 1) * s + 1;
  const lon0 = fine.west + r.i0 * fine.tile, lat0 = fine.south + r.j0 * fine.tile;
  return { lon0, lat0, dx: d, dy: d, nx, ny, west: lon0 - d / 2, east: lon0 + (nx - 0.5) * d, south: lat0 - d / 2, north: lat0 + (ny - 0.5) * d };
}
const regionKey = (r) => (r ? `${r.i0}_${r.j0}_${r.i1}_${r.j1}` : 'all');
const cornersOf = (g) => [[g.west, g.north], [g.east, g.north], [g.east, g.south], [g.west, g.south]];

function packHex(hex) {
  const n = parseInt(hex.slice(1, 7), 16);
  return ((255 << 24) | ((n & 255) << 16) | (n & 0xff00) | ((n >> 16) & 255)) >>> 0;
}

export class EcmwfLayer {
  key = 'ecmwf';
  cadence = null;
  visible = false;
  opacity = 0.8;
  model = 'ecmwf';           // MODELS 的 key
  indexes = {};              // 模式 → index.json
  init = '';                 // '' = 最新一報
  step = null;               // 預報時距(小時);null = 自動選最接近現在的
  variable = 'rain';
  rainHours = 3;
  rainScale = 'rain';        // 雨量色階:rain 小間距 / rainLarge 大間距
  follow = false;            // 對齊時間軸:預報時刻跟著時間軸 T
  showArrows = true;         // 風 / 浪的方向箭頭
  shown = null;              // { key, init, step, field, label }
  cache = new Map();         // `${模式}/${init}/${分塊}/${var}` → Promise<Uint16Array>
  frames = new Map();        // key → Promise<畫好的圖>
  land = null;               // 陸地遮罩(land.js);載入失敗 → null,海浪照原本方塊邊緣畫
  coasts = {};               // 模式 → { g, filled }:最近一次外推出來的格(Uint8Array,1 = 近岸外推)
  region = null;             // 放大時畫面上的 0.1° 分塊範圍 { i0, j0, i1, j1 };null = 用 0.25° 全範圍
  onView = null;             // 分塊範圍變了(要重畫)

  constructor(map) { this.map = map; }

  get name() { return `${MODELS[this.model].name} 預報`; }
  get times() { return []; }                 // 不參與時間軸(預報時間在未來)
  get index() { return this.indexes[this.model] ?? null; }
  idx(m = this.model) { return this.indexes[m] ?? null; }
  initsOf(m = this.model) { return [...(this.idx(m)?.times ?? [])].reverse(); }   // 新 → 舊
  /** 起報 init 的預報時刻;預報長度改過時舊報較短(index 的 nsteps 記每報幾步,steps 是最長的) */
  stepsOf(m = this.model, init) {
    const x = this.idx(m), n = x?.nsteps?.[init];
    return (n ? x.steps.slice(0, n) : x?.steps) ?? [];
  }
  get latest() { return this.index?.latest ?? null; }
  get inits() { return this.initsOf(); }
  get activeInit() { return this.inits.includes(this.init) ? this.init : this.latest; }
  get steps() { return this.stepsOf(this.model, this.activeInit); }
  get vars() { return MODELS[this.model].vars; }
  /** 這一報的格點(舊報有自己的 grid) */
  gridOf(m, init) { const x = this.idx(m); return x?.grids?.[init] ?? x?.grid; }
  /** 這一報有 0.1° 分塊 → 分塊規格 */
  fineOf(m, init) { const x = this.idx(m); return x?.fine && !x.grids?.[init] ? x.fine : null; }

  /** 模式 m 起報 init 目前用的格點:{ key, grid, fine?, r? };key 給定時照 key(畫好的圖記著當時的範圍) */
  view(m, init, key) {
    const fine = this.fineOf(m, init);
    let r = fine ? this.region : null;
    if (key) r = key === 'all' || !fine ? null : (([i0, j0, i1, j1]) => ({ i0, j0, i1, j1 }))(key.split('_').map(Number));
    return r ? { key: regionKey(r), grid: tileGrid(fine, r), fine, r } : { key: 'all', grid: this.gridOf(m, init) };
  }

  /** 單點用:那一點所在的 0.1° 分塊(沒有分塊 → 整個格點) */
  pointView(m, init, lon, lat) {
    const f = this.fineOf(m, init);
    if (!f) return { grid: this.gridOf(m, init), tile: null };
    const i = Math.min(Math.max(Math.floor((lon - f.west) / f.tile), 0), f.ni - 1);
    const j = Math.min(Math.max(Math.floor((lat - f.south) / f.tile), 0), f.nj - 1);
    return { grid: tileGrid(f, { i0: i, i1: i, j0: j, j1: j }), tile: `${i}_${j}` };
  }

  /** 依畫面算 0.1° 分塊範圍;變了回傳 true */
  updateRegion() {
    const f = this.idx('ecmwf')?.fine;
    let r = null;
    if (f && this.map.getZoom() >= FINE_ZOOM) {
      const b = this.map.getBounds(), T = f.tile;
      const W = b.getWest(), E = b.getEast(), S = b.getSouth(), N = b.getNorth();
      const ci = (lon) => Math.min(Math.max(Math.floor((lon - f.west) / T), 0), f.ni - 1);
      const cj = (lat) => Math.min(Math.max(Math.floor((lat - f.south) / T), 0), f.nj - 1);
      if (E > f.west && W < f.west + f.ni * T && N > f.south && S < f.south + f.nj * T) {
        const q = { i0: ci(W), i1: ci(E), j0: cj(S), j1: cj(N) };
        if ((q.i1 - q.i0 + 1) * (q.j1 - q.j0 + 1) <= FINE_MAX_TILES) r = q;
      }
    }
    const changed = regionKey(r) !== regionKey(this.region);
    this.region = r;
    return changed;
  }

  async load() {
    const got = await Promise.allSettled(Object.entries(MODELS).map(async ([m, d]) => [m, await getIndex(d.path)]));
    for (const r of got) if (r.status === 'fulfilled') this.indexes[r.value[0]] = r.value[1];
    if (!Object.keys(this.indexes).length) throw got[0].reason;
    // 陸地遮罩涵蓋所有模式的範圍(IFS / AIFS 西北太平洋,其他在台灣附近)
    const gs = Object.values(this.indexes).map((x) => x.grid);
    const w = Math.min(...gs.map((g) => g.west)), s = Math.min(...gs.map((g) => g.south));
    const e = Math.max(...gs.map((g) => g.east)), n = Math.max(...gs.map((g) => g.north));
    this.land ??= await landMask(w, s, e, n).catch((err) => { console.warn('陸地遮罩載入失敗', err); return null; });
    this.updateRegion();
  }

  /** 換模式:起報、時刻回到自動;這個模式沒有的變數改成降雨 */
  setModel(m) {
    if (!MODELS[m] || m === this.model) return;
    this.model = m;
    this.init = '';
    this.step = null;
    if (!this.vars.includes(this.variable)) this.variable = this.vars[0];
  }

  addTo(beforeId) {
    const m = this.map;
    if (!m.hasImage('st-arrow')) m.addImage('st-arrow', arrowImage(), { sdf: true });
    m.addSource('ecmwf', { type: 'image', url: EMPTY_PNG, coordinates: this.corners() ?? [[115, 28], [130, 28], [130, 17], [115, 17]] });
    m.on('moveend', () => { if (this.updateRegion()) this.onView?.(); });
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

  corners(m = this.model) {
    const g = this.gridOf(m, this.activeInit);
    return g && cornersOf(g);
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
    return this.frameKey(init, step);
  }

  frameKey(init, step) {
    return `${this.model}|${init}|${step}|${this.variable}|${this.rainHours}|${this.rainScale}|${this.view(this.model, init).key}`;
  }

  /** 一個變數的檔(全部預報時刻);tile = 'i_j' → 那一塊 0.1° */
  data(init, v, m = this.model, tile = null) {
    const key = `${m}/${init}/${tile ?? ''}/${v}`;
    if (!this.cache.has(key)) {
      const spec = this.idx(m).vars[v];
      const p = fetch(new URL(`${MODELS[m].path}/${init}/${tile ? `t${tile}/` : ''}${v}.bin.gz`, DATA_BASE_URL).href)
        .then((r) => { if (!r.ok) throw new Error(`${key} ${r.status}`); return r.arrayBuffer(); })
        .then(gunzip)
        .then((buf) => ({ raw: new Uint16Array(buf), spec }));
      p.catch(() => this.cache.delete(key));
      this.cache.set(key, p);
      while (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value);
    }
    return this.cache.get(key);
  }

  /** 第 k 步在 view 格點上的實際值(Float32,NaN = 無資料);分塊的各塊同時下載、拼起來 */
  async slice(init, v, k, m = this.model, view = this.view(m, init)) {
    const g = view.grid, out = new Float32Array(g.nx * g.ny);
    const put = ({ raw, spec }, ox, oy, w, h) => {
      const base = k * w * h;
      for (let y = 0; y < h; y++) {
        for (let x = 0, row = (oy + y) * g.nx + ox, src = base + y * w; x < w; x++) {
          const q = raw[src + x];
          out[row + x] = q === spec.nodata || q === undefined ? NaN : q * spec.scale + spec.offset;
        }
      }
    };
    if (!view.fine) put(await this.data(init, v, m), 0, 0, g.nx, g.ny);
    else {
      const { fine, r } = view, s = fine.n - 1, tiles = [];
      for (let j = r.j0; j <= r.j1; j++) for (let i = r.i0; i <= r.i1; i++) tiles.push([i, j]);
      const got = await Promise.all(tiles.map(([i, j]) => this.data(init, v, m, `${i}_${j}`)));
      got.forEach((d, q) => put(d, (tiles[q][0] - r.i0) * s, (tiles[q][1] - r.j0) * s, fine.n, fine.n));
    }
    if (WAVE_VARS.has(v)) this.fillCoast(out, g, v === 'mwd', m);
    return out;
  }

  /** 海浪往陸地外推:無值的格取周圍 8 格有值的平均,重複 FILL_ITERS 次;波向(circ)用單位向量平均 */
  fillCoast(a, g, circ, m) {
    const { nx, ny } = g;
    const parts = circ ? [a.map((d) => Math.sin((d * Math.PI) / 180)), a.map((d) => Math.cos((d * Math.PI) / 180))] : [a];
    const filled = new Uint8Array(a.length);
    for (let it = 0; it < FILL_ITERS; it++) {
      const add = [];
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const i = y * nx + x;
          if (!Number.isNaN(parts[0][i])) continue;
          const sum = parts.map(() => 0);
          let n = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx, yy = y + dy, j = yy * nx + xx;
              if (xx < 0 || yy < 0 || xx >= nx || yy >= ny || Number.isNaN(parts[0][j])) continue;
              parts.forEach((p, k) => { sum[k] += p[j]; });
              n++;
            }
          }
          if (n) add.push([i, sum.map((s) => s / n)]);
        }
      }
      if (!add.length) break;
      for (const [i, m] of add) { parts.forEach((p, k) => { p[i] = m[k]; }); filled[i] = 1; }
    }
    if (circ) for (let i = 0; i < a.length; i++) if (filled[i]) a[i] = ((Math.atan2(parts[0][i], parts[1][i]) * 180) / Math.PI + 360) % 360;
    this.coasts[m] = { g, filled };         // 陸地格固定,每個變數、每個時刻都一樣(同一個格點範圍)
  }

  /** 經緯度落在外推格(近岸外推)上 */
  coastAt(lon, lat, m = 'ecmwf') {
    const { g, filled: coast } = this.coasts[m] ?? {};
    if (!coast || !g) return false;
    const ix = Math.round((lon - g.lon0) / g.dx), iy = Math.round((lat - g.lat0) / g.dy);
    return ix >= 0 && iy >= 0 && ix < g.nx && iy < g.ny && coast[iy * g.nx + ix] === 1;
  }

  /** 模式 m 的變數在第 step 小時的場;回傳 { field, u, v, label } */
  async field(m, init, step, variable, rainHours, view = this.view(m, init)) {
    const steps = this.stepsOf(m, init), k = steps.indexOf(step);
    const slice = (v, kk) => this.slice(init, v, kk, m, view);
    if (variable === 'rain') {
      const w = rainHours || step;                  // 0 = 起報後累積
      // 時段起點取 step - w 之前(含)最近的時刻(3 km 每 6 小時:選 3 小時會變成 6 小時)
      const from = [...steps].reverse().find((s) => s <= Math.max(step - w, 0)) ?? 0, k0 = steps.indexOf(from);
      const a = await slice('tp', k);
      if (from > 0) {
        const b = await slice('tp', k0);
        for (let i = 0; i < a.length; i++) a[i] = Math.max(a[i] - b[i], 0);
      }
      const span = step - from;
      const label = rainHours && span < rainHours ? `起報後 ${span} 小時雨量` : rainHours ? `${span} 小時雨量` : `起報後累積雨量（${step} 小時）`;
      return { field: a, label };
    }
    if (variable === 'wind' || variable === 'gust') {
      const [u, v] = await Promise.all([slice('u10', k), slice('v10', k)]);
      const f = variable === 'gust' ? await slice('gust', k) : u.map((x, i) => Math.hypot(x, v[i]));
      return { field: f, u, v, label: variable === 'gust' ? `陣風（該時刻前 ${step <= 90 ? 1 : step <= 144 ? 3 : 6} 小時最大）` : '10 m 平均風' };
    }
    if (variable === 'swh' || variable === 'pp1d' || variable === 'mwp') {   // 海浪:箭頭畫浪前進方向(mwd 是來向,轉 180°)
      const [f, d] = await Promise.all([slice(variable, k), slice('mwd', k)]);
      const rad = d.map((x) => ((x + 180) * Math.PI) / 180);
      return { field: f, u: rad.map(Math.sin), v: rad.map(Math.cos), label: variable === 'swh' ? '示性波高' : EC_VARS[variable].name };
    }
    return { field: await slice(variable, k), label: EC_VARS[variable].name };
  }

  scale(variable) {
    if (variable === 'rain') return SCALES[this.rainScale];  // 氣象署色階,面板「間距」切換小 / 大
    if (variable === 't2') return SCALES.temp;
    if (variable === 'msl') return SCALES.pres;
    if (variable === 'swh') return SCALES.wave;
    if (variable === 'pp1d' || variable === 'mwp') return SCALES.period;
    return SCALES.wind;
  }

  async render(f, g, sc, mask = false) {
    const UP = Math.max(1, Math.min(Math.max(2, Math.round(g.dx / PX_DEG)), Math.floor(MAX_PX / Math.max(g.nx, g.ny))));
    const W = g.nx * UP, H = g.ny * UP;
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
    if (mask && this.land) {                  // 挖掉陸地(和底圖海岸線同一份)
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = '#000';
      this.land.fill(ctx, (lon) => ((lon - g.west) / (g.east - g.west)) * W, (lat) => ((yN - mercY(lat)) / (yN - yS)) * H,
        [g.west, g.south, g.east, g.north]);
      ctx.globalCompositeOperation = 'source-over';
    }
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    return URL.createObjectURL(blob);
  }

  arrows(u, v, g, mask = false) {
    const features = [], land = mask ? this.land : null;
    const every = Math.max(1, Math.round(ARROW_DEG / g.dx), Math.ceil(Math.sqrt((g.nx * g.ny) / ARROWS_MAX)));
    for (let y = 0; y < g.ny; y += every) {
      for (let x = 0; x < g.nx; x += every) {
        const i = y * g.nx + x, uu = u[i], vv = v[i];
        const lon = g.lon0 + x * g.dx, lat = g.lat0 + y * g.dy;
        if (Number.isNaN(uu) || Number.isNaN(vv) || land?.isLand(lon, lat)) continue;
        features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] },
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
      src.updateImage({ url: EMPTY_PNG, coordinates: this.corners(this.model) ?? src.coordinates });
      arr.setData(EMPTY);
      this.shown = null;
      return;
    }
    const f = await this.frame(key);
    if (this.wanted !== key) return;
    src.updateImage({ url: f.url, coordinates: cornersOf(f.grid) });
    arr.setData(f.arrows);
    this.shown = { key, ...f };
  }

  /** 一張畫好的圖(場、色階、PNG、箭頭);留著給播放重複用 */
  frame(key) {
    if (!this.frames.has(key)) {
      const [model, init, s, variable, rh, , vk] = key.split('|'), step = +s;
      const p = (async () => {
        const view = this.view(model, init, vk), g = view.grid;
        const r = await this.field(model, init, step, variable, +rh, view);
        const sc = this.scale(variable), mask = WAVE_VARS.has(variable);
        return { model, init, step, variable, grid: g, field: r.field, label: r.label, sc, url: await this.render(r.field, g, sc, mask),
          arrows: r.u ? this.arrows(r.u, r.v, g, mask) : EMPTY };
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
    const init = this.activeInit, keys = this.steps.map((s) => this.frameKey(init, s));
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
    const g = this.shown.grid;
    const ix = Math.round((lng - g.lon0) / g.dx), iy = Math.round((lat - g.lat0) / g.dy);
    if (ix < 0 || iy < 0 || ix >= g.nx || iy >= g.ny) return null;
    const x = this.shown.field[iy * g.nx + ix], v = this.shown.variable, wave = WAVE_VARS.has(v);
    if (Number.isNaN(x) || (wave && this.land?.isLand(lng, lat))) return null;
    const unit = EC_VARS[v].unit;
    const cls = v === 'swh' && waveClass(x) ? `（${waveClass(x)}）` : '';
    const ext = wave && this.coastAt(lng, lat, this.shown.model) ? '（近岸外推）' : '';
    return `${MODELS[this.shown.model].name} ${EC_VARS[v].name} ${x.toFixed(1)} ${unit}${cls}${ext}`;
  }

  legend() {
    if (!this.shown) return `<div class="legend-title">${this.name}（無資料）</div>`;
    const { model, variable, sc, label, init, step } = this.shown;
    const title = `${MODELS[model].name} ${label}（${fmtEcInit(init)} +${step}h）`;
    if (variable === 'wind' || variable === 'gust') return beaufortLegendHTML(`${title}（蒲福風級）`, sc.colors);
    const html = legendHTML(`${title} (${EC_VARS[variable].unit})`, sc.levels, sc.colors, 0, 22, sc.ticks, sc.openTop);
    if (variable === 'swh') {
      const cls = WAVE_CLASSES.map(([lo, name], i) => `${name} ${lo}${WAVE_CLASSES[i + 1] ? `–${WAVE_CLASSES[i + 1][0]}` : ' 以上'}`);
      return `${withInfo(html, WAVE_NOTE[model])}<div class="legend-labels" style="margin-top:4px">${cls.join('｜')} m</div>`;
    }
    return variable === 'pp1d' || variable === 'mwp' ? withInfo(html, WAVE_NOTE[model]) : html;
  }
}

/** 檔案是 gzip;伺服器若已解壓就直接用(同 data.js) */
async function gunzip(buf) {
  const u8 = new Uint8Array(buf);
  if (u8[0] !== 0x1f || u8[1] !== 0x8b) return buf;
  const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

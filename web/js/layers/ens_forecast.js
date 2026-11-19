// 系集預報(CorrDiff 16 個樣本;pipeline/fetch_corrdiff.py):每個時刻可看平均、最大、最小、超過門檻的機率、單一成員。
// 平均 / 最大 / 最小讀預先算好的檔;機率、單一成員才下載全部成員(一個時刻一個變數約 1 MB)。
import { beaufortLegendHTML, DBZ_COLORS, DBZ_LEVELS, legendHTML, SCALES, withInfo } from '../colormaps.js';
import { addMin, fmtTW } from '../time.js';
import { ALL_MODELS, fmtEcInit, MIN_DBZ } from './ecmwf.js';
import { EMPTY_PNG } from './radar.js';

export const EF_VARS = { mrr: { name: '最大回波', unit: 'dBZ' }, t2: { name: '2 m 溫度', unit: '°C' }, wind: { name: '10 m 風速', unit: 'm/s' } };
export const EF_STATS = { mean: '平均', max: '最大', min: '最小', prob: '機率', member: '單一成員' };
// 機率門檻:[值, 方向(1 = 以上,-1 = 以下), 說明]
export const EF_THR = {
  mrr: [[20, 1, '≥ 20 dBZ'], [35, 1, '≥ 35 dBZ'], [45, 1, '≥ 45 dBZ']],
  t2: [[35, 1, '≥ 35 °C'], [30, 1, '≥ 30 °C'], [10, -1, '≤ 10 °C'], [6, -1, '≤ 6 °C']],
  wind: [[10.8, 1, '≥ 6 級'], [17.2, 1, '≥ 8 級'], [24.5, 1, '≥ 10 級']],
};
const PROB = { levels: [5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
  colors: ['#d9f0ff', '#a6dcf5', '#6cc3e8', '#3ea86b', '#8fce3c', '#f2e13a', '#f9b32c', '#f27a24', '#e03a26', '#a8128c', '#6a0f8e'], min: 5 };
const NOTE = '系集 = CorrDiffTaiwan 對同一份 IFS／AIFS 預報取樣 16 次，只反映降尺度的不確定性，不含大尺度預報本身的誤差；模型餵預報場超出訓練條件，屬實驗產品。機率 = 16 個樣本中達到門檻的比例。';
const FRAMES_MAX = 30;

export class EnsForecastLayer {
  key = 'ensfc';
  name = '系集預報';
  cadence = null;
  visible = false;
  opacity = 0.85;
  model = 'cdifs';
  variable = 'mrr';
  stat = 'mean';
  thr = 1;                   // EF_THR[變數] 的第幾個
  member = 1;
  init = '';                 // '' = 最新
  step = null;               // null = 最接近現在
  follow = false;
  shown = null;
  frames = new Map();

  constructor(map, ec) { this.map = map; this.ec = ec; }

  get x() { return this.ec.idx(this.model); }
  get inits() { const x = this.x; return x ? x.times.filter((t) => x.ens_nsteps?.[t] > 0) : []; }
  get index() { return this.inits.length ? this.x : null; }
  get times() { return []; }                 // 預報時間在未來,不參與時間軸
  get activeInit() { const a = this.inits; return a.includes(this.init) ? this.init : a[a.length - 1] ?? null; }
  get latest() { return this.activeInit; }
  get steps() { const t = this.activeInit; return t ? this.x.steps.slice(0, this.x.ens_nsteps[t]) : []; }
  get members() { return this.x?.members ?? 16; }
  get thrDef() { const a = EF_THR[this.variable]; return a[Math.min(this.thr, a.length - 1)]; }

  async load() { /* index 由模式預報圖層一起載入 */ }

  addTo(beforeId) {
    this.map.addSource('ensfc', { type: 'image', url: EMPTY_PNG, coordinates: [[116, 28], [125.6, 28], [125.6, 19.5], [116, 19.5]] });
    this.map.addLayer({ id: 'ensfc', type: 'raster', source: 'ensfc', layout: { visibility: 'none' },
      paint: { 'raster-opacity': this.opacity, 'raster-resampling': 'linear', 'raster-fade-duration': 0 } }, beforeId);
  }

  validOf(init, s) { return addMin(init, s * 60); }

  /** 不晚於 target 的最後一個時刻(都晚於 target 就取第一個) */
  stepAt(target) {
    const init = this.activeInit, st = this.steps;
    return st.reduce((b, s) => (this.validOf(init, s) <= target ? s : b), st[0] ?? null);
  }

  pick(T) {
    const init = this.activeInit;
    if (!this.visible || !init) return null;
    const now = new Date().toISOString().replace(/\D/g, '').slice(0, 12);
    let s = this.follow && T ? this.stepAt(T) : this.step;
    if (s == null || !this.steps.includes(s)) s = this.stepAt(now);
    if (s == null) return null;
    this.pickedStep = s;
    const extra = this.stat === 'prob' ? this.thr : this.stat === 'member' ? this.member : '';
    return [this.model, init, s, this.variable, this.stat, extra].join('|');
  }

  scale(v, stat) { return stat === 'prob' ? PROB : this.ec.scale(v); }

  async field(m, init, step, v, stat, extra) {
    const g = this.ec.gridOf(m, init), n = g.nx * g.ny, f = new Float32Array(n);
    if (stat === 'mean' || stat === 'max' || stat === 'min') {
      const { raw, spec } = await this.ec.stepData(init, v, step, m, stat);
      for (let i = 0; i < n; i++) f[i] = raw[i] === spec.nodata ? NaN : raw[i] * spec.scale + spec.offset;
      return f;
    }
    const { raw, spec } = await this.ec.ensMembers(init, v, step, m), N = raw.length / n;
    if (stat === 'member') {
      const base = (Math.min(extra, N) - 1) * n;
      for (let i = 0; i < n; i++) { const q = raw[base + i]; f[i] = q === spec.nodata ? NaN : q * spec.scale + spec.offset; }
      return f;
    }
    const [thr, dir] = EF_THR[v][extra];
    for (let i = 0; i < n; i++) {
      let c = 0, ok = 0;
      for (let k = 0; k < N; k++) {
        const q = raw[k * n + i];
        if (q === spec.nodata) continue;
        ok++;
        const x = q * spec.scale + spec.offset;
        if (dir > 0 ? x >= thr : x <= thr) c++;
      }
      f[i] = ok ? (c / ok) * 100 : NaN;
    }
    return f;
  }

  frame(key) {
    if (!this.frames.has(key)) {
      const [m, init, s, v, stat, extra] = key.split('|');
      const p = (async () => {
        const g = this.ec.gridOf(m, init), field = await this.field(m, init, +s, v, stat, +extra), sc = this.scale(v, stat);
        return { m, init, step: +s, v, stat, extra: +extra, g, field, url: await this.ec.render(field, g, sc) };
      })();
      p.catch(() => this.frames.delete(key));
      this.frames.set(key, p);
      while (this.frames.size > FRAMES_MAX) {
        const [k, old] = this.frames.entries().next().value;
        this.frames.delete(k);
        if (k === this.shown?.key) { this.frames.set(k, old); continue; }
        old.then((x) => URL.revokeObjectURL(x.url)).catch(() => {});
      }
    }
    return this.frames.get(key);
  }

  async show(key) {
    if (key && this.shown?.key === key) return;
    this.wanted = key;
    const src = this.map.getSource('ensfc');
    if (!key) {
      if (this.shown) src.updateImage({ url: EMPTY_PNG, coordinates: src.coordinates });
      this.shown = null;
      return;
    }
    const f = await this.frame(key);
    if (this.wanted !== key) return;
    const { west: w, east: e, south: s, north: n } = f.g;
    src.updateImage({ url: f.url, coordinates: [[w, n], [e, n], [e, s], [w, s]] });
    this.shown = { key, ...f };
  }

  timeLabel() {
    if (!this.shown) return null;
    const { init, step } = this.shown;
    return { text: `${fmtTW(this.validOf(init, step))}（${fmtEcInit(init)} +${step}h）` };
  }

  setVisible(v) { this.visible = v; this.map.setLayoutProperty('ensfc', 'visibility', v ? 'visible' : 'none'); }
  setOpacity(v) { this.opacity = v; this.map.setPaintProperty('ensfc', 'raster-opacity', v); }

  statLabel(s = this.shown) {
    if (s.stat === 'prob') return `${EF_THR[s.v][s.extra][2]} 機率`;
    return s.stat === 'member' ? `成員 ${s.extra}` : EF_STATS[s.stat];
  }

  valueAt(lng, lat) {
    const s = this.shown;
    if (!this.visible || !s) return null;
    const ix = Math.round((lng - s.g.lon0) / s.g.dx), iy = Math.round((lat - s.g.lat0) / s.g.dy);
    if (ix < 0 || iy < 0 || ix >= s.g.nx || iy >= s.g.ny) return null;
    const x = s.field[iy * s.g.nx + ix];
    if (Number.isNaN(x)) return null;
    const head = `系集 ${this.statLabel(s)}`;
    if (s.stat === 'prob') return `${head} ${x.toFixed(0)}%`;
    if (s.v === 'mrr' && x < MIN_DBZ) return `${head} 無回波`;
    return `${head} ${x.toFixed(1)} ${EF_VARS[s.v].unit}`;
  }

  legend() {
    const s = this.shown;
    if (!s) return `<div class="legend-title">${this.name}（無資料）</div>`;
    const title = `系集預報 ${ALL_MODELS[s.m].name} ${EF_VARS[s.v].name} ${this.statLabel(s)}（${fmtEcInit(s.init)} +${s.step}h）`;
    let h;
    if (s.stat === 'prob') h = legendHTML(`${title} (%)`, PROB.levels, PROB.colors, 0);
    else if (s.v === 'mrr') h = legendHTML(`${title} (dBZ)`, DBZ_LEVELS, DBZ_COLORS);
    else if (s.v === 't2') h = legendHTML(`${title} (°C)`, SCALES.temp.levels, SCALES.temp.colors, 0, 22, SCALES.temp.ticks);
    else h = beaufortLegendHTML(`${title}（蒲福風級）`, SCALES.wind.colors);
    return withInfo(h, NOTE);
  }
}

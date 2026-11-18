// CorrDiff 降尺度(pipeline/fetch_corrdiff.py):IFS / AIFS 餵 CorrDiffTaiwan → 約 2 公里最大回波、2 m 溫度、10 m 風。
// 每個時刻每個變數一個 uint8 檔;實驗產品,只是一種可能結果。
import { getGrid, getIndex } from '../data.js';
import { binLUT, DBZ_COLORS, DBZ_LEVELS, beaufortLegendHTML, legendHTML, SCALES, withInfo } from '../colormaps.js';
import { addMin, diffMin, fmtTW } from '../time.js';
import { EMPTY_PNG, renderPNG } from './radar.js';

const CACHE_MAX = 90;
const MIN_DBZ = 5;           // 訓練資料晴空約 0 dBZ,低於這個當無回波(不畫)
export const CD_MODELS = { ifs: 'IFS', aifs: 'AIFS' };
export const CD_VARS = { mrr: '最大回波', t2: '2 m 溫度', wind: '10 m 風速' };
const NOTE = 'CorrDiffTaiwan 以 ERA5 → WRF（2018–2021）訓練，這裡餵 IFS／AIFS 預報場，超出訓練條件，屬實驗產品；每個時刻只取樣一次，是一種可能結果，不是機率。';

export class CorrDiffLayer {
  key = 'corrdiff';
  name = 'CorrDiff 降尺度';
  cadence = null;
  visible = false;
  opacity = 0.85;
  model = 'ifs';
  variable = 'mrr';
  init = '';                 // '' = 最新
  step = null;               // null = 最接近現在的時刻
  follow = false;            // 時刻跟著時間軸
  indexes = {};
  cache = new Map();
  current = null;

  constructor(map) { this.map = map; }

  get index() { return this.indexes[this.model] ?? null; }
  get times() { return []; }                 // 預報時間在未來,不參與時間軸
  get latest() { return this.activeInit; }
  get inits() { const i = this.index; return i ? i.times.filter((t) => i.nsteps?.[t] > 0) : []; }
  get activeInit() { const a = this.inits; return a.includes(this.init) ? this.init : a[a.length - 1] ?? null; }
  /** 這一報已完成的時效 */
  get steps() { const i = this.index, t = this.activeInit; return t ? i.steps.slice(0, i.nsteps[t]) : []; }

  async load() {
    await Promise.all(Object.keys(CD_MODELS).map(async (m) => {
      try { this.indexes[m] = await getIndex(`corrdiff/${m}`); } catch { /* 還沒有資料 */ }
    }));
    if (!Object.values(this.indexes).some(Boolean)) throw new Error('corrdiff index 404');
  }

  addTo(beforeId) {
    this.map.addSource('corrdiff', { type: 'image', url: EMPTY_PNG, coordinates: [[116, 28], [125.6, 28], [125.6, 19.5], [116, 19.5]] });
    this.map.addLayer({ id: 'corrdiff', type: 'raster', source: 'corrdiff', layout: { visibility: 'none' },
      paint: { 'raster-opacity': this.opacity, 'raster-resampling': 'nearest', 'raster-fade-duration': 0 } }, beforeId);
  }

  /** valid 時間最接近 target 的時效(不超過 target 優先) */
  stepAt(target) {
    const init = this.activeInit, st = this.steps;
    if (!init || !st.length) return null;
    const h = diffMin(target, init) / 60;
    return st.reduce((b, s) => (s <= h ? s : b), st[0]);
  }

  pick(T) {
    const init = this.activeInit;
    if (!this.visible || !init) return null;
    const now = new Date().toISOString().slice(0, 16).replace(/[-T:]/g, '');
    let s = this.follow && T ? this.stepAt(T) : this.step;
    if (s == null || !this.steps.includes(s)) s = this.stepAt(now);
    if (s == null) return null;
    this.pickedStep = s;
    return `${this.model}|${init}|${this.variable}|${s}`;
  }

  lut(spec) {
    if (this.variable === 'mrr') return binLUT(spec, DBZ_LEVELS, DBZ_COLORS, { minVisible: MIN_DBZ });
    const sc = this.variable === 't2' ? SCALES.temp : SCALES.wind;
    return binLUT(spec, sc.levels, sc.colors);
  }

  frame(key) {
    if (!this.cache.has(key)) {
      const [m, init, v, s] = key.split('|');
      const g = this.indexes[m].vars[v];
      const lut = this.lut(g);
      const p = getGrid(`corrdiff/${m}/${init}`, `${v}_${String(s).padStart(3, '0')}`, g)
        .then(async (raw) => ({ raw, g, url: await renderPNG(raw, g, lut) }));
      p.catch(() => this.cache.delete(key));
      this.cache.set(key, p);
      if (this.cache.size > CACHE_MAX) {
        const [old, f] = this.cache.entries().next().value;
        this.cache.delete(old);
        f.then((x) => URL.revokeObjectURL(x.url)).catch(() => {});
      }
    }
    return this.cache.get(key);
  }

  async show(key) {
    if (key && this.current?.key === key) return;
    this.wanted = key;
    const src = this.map.getSource('corrdiff');
    if (!key) {
      if (this.current) src.updateImage({ url: EMPTY_PNG, coordinates: this.current.g.corners });
      this.current = null;
      return;
    }
    const f = await this.frame(key);
    if (this.wanted !== key) return;
    src.updateImage({ url: f.url, coordinates: f.g.corners });
    this.current = { key, raw: f.raw, g: f.g };
  }

  timeLabel() {
    const init = this.activeInit;
    if (this.pickedStep == null || !init) return null;
    return { text: `${fmtTW(addMin(init, this.pickedStep * 60))}（+${this.pickedStep}h）` };
  }

  setVisible(v) { this.visible = v; this.map.setLayoutProperty('corrdiff', 'visibility', v ? 'visible' : 'none'); }
  setOpacity(v) { this.opacity = v; this.map.setPaintProperty('corrdiff', 'raster-opacity', v); }

  valueAt(lng, lat) {
    if (!this.visible || !this.current) return null;
    const { g, raw } = this.current;
    const ix = Math.round((lng - g.lon0) / g.dx), iy = Math.round((lat - g.lat0) / g.dy);
    if (ix < 0 || iy < 0 || ix >= g.nx || iy >= g.ny) return null;
    const r = raw[iy * g.nx + ix];
    if (r === g.nodata) return null;
    const v = r * g.scale + g.offset;
    if (this.variable === 'mrr' && v < MIN_DBZ) return 'CorrDiff 無回波';
    return `CorrDiff ${v.toFixed(this.variable === 'mrr' ? 0 : 1)} ${g.units}`;
  }

  legend() {
    const t = `CorrDiff ${CD_MODELS[this.model]} ${CD_VARS[this.variable]}`;
    let h;
    if (this.variable === 'mrr') h = legendHTML(`${t} (dBZ)`, DBZ_LEVELS, DBZ_COLORS);
    else if (this.variable === 't2') h = legendHTML(`${t} (°C)`, SCALES.temp.levels, SCALES.temp.colors, 0, 22, SCALES.temp.ticks);
    else h = beaufortLegendHTML(`${t}（蒲福風級）`, SCALES.wind.colors);
    return withInfo(h, NOTE);
  }
}

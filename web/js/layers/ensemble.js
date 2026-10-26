// 系集颱風路徑:每個模式各自設定初始時間、成員 / 平均 / 控制報、預報時距、透明度
// 預報區間兩種:「預報時距」= 各模式自己的 tau 範圍;「有效時間對齊」= 所有模式共用同一個有效時間窗
// 細線 = 成員、粗實線 = 系集平均、粗虛線 = 控制報(同 TY_ENS_3.ipynb 的畫法)
import { getIndex, getJSON } from '../data.js';
import { addMin, diffMin, fmtTW, latestLE } from '../time.js';
import { fmtLon, lon360 } from '../lon.js';

export const MODEL_COLORS = {
  ECMWF: '#e53935', AIFS: '#fb8c00', GEFS: '#1e88e5', AIGEFS: '#00acc1',
  WNV3: '#43a047', FNV3P1: '#8e24aa', FNV3P2: '#d81b60', FNV3: '#7cb342',
};
export const MODEL_NAMES = {
  ECMWF: 'ECMWF ENS', AIFS: 'ECMWF AIFS', GEFS: 'NCEP GEFS', AIGEFS: 'NCEP AIGEFS',
  WNV3: 'WeatherLab WNV3', FNV3P1: 'WeatherLab FNV3 P1', FNV3P2: 'WeatherLab FNV3 P2', FNV3: 'WeatherLab FNV3',
};
const EMPTY = { type: 'FeatureCollection', features: [] };
const initStamp = (init) => `${init}00`;          // 'YYYYMMDDHH' → 'YYYYMMDDHHMM'
export const fmtInit = (init) => `${init.slice(4, 6)}/${init.slice(6, 8)} ${init.slice(8, 10)}Z`;
const isControl = (mb) => mb.ftype === 0 || mb.ftype === 1;

export const defaultCfg = () => ({ on: true, init: '', members: true, mean: true, control: true, tau: [0, 120], opacity: 0.8 });

export class EnsembleLayer {
  key = 'ens';
  name = '系集路徑';
  path = 'typhoon/ens';
  cadence = null;
  visible = true;
  index = null;
  cache = new Map();
  files = {};              // init → 已載入的 JSON
  tc = '';                 // 颱風 id
  baseInit = '';           // '' = 依時間軸;否則 'YYYYMMDDHH'
  cfg = {};                // 模式 → defaultCfg()
  mode = 'tau';            // 'tau' | 'valid'
  validStart = '';         // '' = 自動(最晚的初始時間);否則 stamp
  validHours = 120;
  opts = { dropOutlier: true, best: true, start: true };
  bestTrack = null;
  resolved = {};           // 模式 → 實際使用的初始時間

  constructor(map) { this.map = map; }

  get times() { return this.index?.times ?? []; }
  get latest() { return this.index?.latest ?? null; }
  get models() { return Object.keys(this.index?.models ?? {}); }

  async load() {
    this.index = await getIndex(this.path);
    for (const m of this.models) this.cfg[m] ??= defaultCfg();
    const tcs = Object.keys(this.index.tcs ?? {});
    if (!tcs.includes(this.tc)) this.tc = tcs[tcs.length - 1] ?? '';
  }

  addTo(beforeId) {
    const m = this.map;
    for (const id of ['ens-members', 'ens-mean', 'ens-best']) m.addSource(id, { type: 'geojson', data: EMPTY });
    m.addLayer({ id: 'ens-members', type: 'line', source: 'ens-members',
      paint: { 'line-color': ['get', 'color'], 'line-width': 1, 'line-opacity': ['*', ['get', 'op'], 0.45] } }, beforeId);
    m.addLayer({ id: 'ens-best-line', type: 'line', source: 'ens-best', filter: ['==', '$type', 'LineString'],
      paint: { 'line-color': '#000', 'line-width': 4.5, 'line-opacity': 0.85 } }, beforeId);
    m.addLayer({ id: 'ens-best-line2', type: 'line', source: 'ens-best', filter: ['==', '$type', 'LineString'],
      paint: { 'line-color': '#fff', 'line-width': 2 } }, beforeId);
    m.addLayer({ id: 'ens-mean-line', type: 'line', source: 'ens-mean', filter: ['==', ['get', 'kind'], 'mean'],
      paint: { 'line-color': ['get', 'color'], 'line-width': 3.5, 'line-opacity': ['get', 'op'] } }, beforeId);
    m.addLayer({ id: 'ens-ctl-line', type: 'line', source: 'ens-mean', filter: ['==', ['get', 'kind'], 'control'],
      paint: { 'line-color': ['get', 'color'], 'line-width': 2.5, 'line-dasharray': [2, 1.5], 'line-opacity': ['get', 'op'] } }, beforeId);
    m.addLayer({ id: 'ens-start', type: 'circle', source: 'ens-mean', filter: ['==', ['get', 'kind'], 'start'],
      paint: { 'circle-radius': 5, 'circle-color': ['get', 'color'], 'circle-opacity': ['get', 'op'],
        'circle-stroke-color': '#000', 'circle-stroke-width': 1.5, 'circle-stroke-opacity': ['get', 'op'] } }, beforeId);
    m.addLayer({ id: 'ens-mean-pt', type: 'circle', source: 'ens-mean', filter: ['==', ['get', 'kind'], 'meanpt'],
      paint: { 'circle-radius': 3, 'circle-color': ['get', 'color'], 'circle-opacity': ['get', 'op'],
        'circle-stroke-color': '#000', 'circle-stroke-width': 1, 'circle-stroke-opacity': ['get', 'op'] } }, beforeId);
    m.addLayer({ id: 'ens-best-pt', type: 'circle', source: 'ens-best', filter: ['==', '$type', 'Point'],
      paint: { 'circle-radius': 3, 'circle-color': '#fff', 'circle-stroke-color': '#000', 'circle-stroke-width': 1 } }, beforeId);

    m.on('click', 'ens-mean-pt', (e) => {
      const p = e.features[0].properties;
      new maplibregl.Popup({ maxWidth: '300px' }).setLngLat(e.features[0].geometry.coordinates).setHTML(
        `<div class="popup-title">${MODEL_NAMES[p.model] ?? p.model} 系集平均</div>
         <div>初始 ${fmtInit(p.init)}（台灣 ${fmtTW(initStamp(p.init), 'md')}）</div>
         <div>+${p.tau} 小時 → 有效時間 ${fmtTW(p.valid, 'full')}</div>
         <div>位置 ${(+p.lat).toFixed(1)}°N ${fmtLon(+p.lon)}　成員 ${p.n}</div>
         <div>平均氣壓 ${p.p === 'null' || p.p == null ? '—' : `${p.p} hPa`}</div>`).addTo(m);
    });
    m.on('click', 'ens-best-pt', (e) => {
      const p = e.features[0].properties;
      new maplibregl.Popup().setLngLat(e.features[0].geometry.coordinates)
        .setHTML(`<div class="popup-title">實際路徑（氣象署定位）</div><div>${fmtTW(p.t, 'full')}</div>`).addTo(m);
    });
    for (const id of ['ens-mean-pt', 'ens-best-pt']) {
      m.on('mouseenter', id, () => { m.getCanvas().style.cursor = 'pointer'; });
      m.on('mouseleave', id, () => { m.getCanvas().style.cursor = ''; });
    }
  }

  /** 依時間軸:同步取 ≤ T 的最新初始時間,不同步取最新 */
  pick(T, sync) {
    if (this.baseInit) return initStamp(this.baseInit);
    return sync ? latestLE(this.times, T) : this.latest;
  }

  /** 每個模式實際要用的初始時間:模式指定 > 共用;該模式沒有這個時間就取 ≤ 它的最新一筆 */
  resolve(baseStamp) {
    const base = baseStamp ? baseStamp.slice(0, 10) : null;
    const res = {};
    for (const m of this.models) {
      const c = this.cfg[m];
      if (!c.on) continue;
      const want = c.init || base;
      const got = want ? latestLE(this.index.models[m], want) : null;
      if (got) res[m] = got;
    }
    return res;
  }

  async loadInit(init) {
    if (!this.cache.has(init)) {
      // 經度換成 0–360°(跨換日線的成員路徑、系集平均才連續;見 lon.js)
      const p = getJSON(`${this.path}/${init}.json`).then((d) => {
        for (const tc of d.tcs ?? []) for (const list of Object.values(tc.models ?? {})) for (const mb of list) mb.lon = mb.lon.map(lon360);
        return d;
      });
      p.catch(() => this.cache.delete(init));
      this.cache.set(init, p);
    }
    return this.cache.get(init);
  }

  async show(stamp) {
    this.wanted = stamp;
    const res = this.resolve(stamp);
    const inits = [...new Set(Object.values(res))];
    const loaded = await Promise.all(inits.map((i) => this.loadInit(i)));
    if (this.wanted !== stamp) return;
    this.files = Object.fromEntries(inits.map((i, k) => [i, loaded[k]]));
    this.resolved = res;
    this.draw();
  }

  /** 有效時間模式的起點:指定值,或所有使用中初始時間的最晚者(= 大家都有預報的最早共同時刻) */
  windowStart() {
    if (this.validStart) return this.validStart;
    const inits = Object.values(this.resolved);
    return inits.length ? initStamp(inits.reduce((a, b) => (a > b ? a : b))) : null;
  }

  /** 某模式要畫的 tau 範圍 */
  tauWindow(model, init) {
    if (this.mode === 'tau') return this.cfg[model].tau;
    const start = this.windowStart();
    if (!start) return [0, -1];
    const a = diffMin(start, initStamp(init)) / 60;
    return [a, a + this.validHours];
  }

  draw() {
    const members = [], mean = [], best = [];
    for (const [model, init] of Object.entries(this.visible ? this.resolved : {})) {
      const c = this.cfg[model];
      const list = this.files[init]?.tcs.find((t) => t.id === this.tc)?.models[model];
      if (!list) continue;
      const color = MODEL_COLORS[model] ?? '#888';
      const props = { color, op: c.opacity };
      const [a, b] = this.tauWindow(model, init);
      const use = list.filter((mb) => !(this.opts.dropOutlier && mb.out));
      const clip = (mb) => mb.tau.map((t, i) => [t, mb.lon[i], mb.lat[i], mb.p[i]]).filter(([t]) => t >= a && t <= b);
      const line = (pts, extra) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: pts.map((q) => [q[1], q[2]]) }, properties: { ...props, ...extra } });

      for (const mb of use) {
        const pts = clip(mb);
        if (pts.length < 2) continue;
        if (isControl(mb)) { if (c.control) mean.push(line(pts, { kind: 'control' })); }
        else if (c.members) members.push(line(pts, {}));
      }

      // 系集平均:每個 tau 取擾動成員平均(成員數不足 1/3 的 tau 不畫,避免尾端只剩少數成員亂飄)
      const perts = use.filter((mb) => !isControl(mb));
      const byTau = new Map();
      for (const mb of perts) {
        for (const [t, lon, lat, p] of clip(mb)) {
          const s = byTau.get(t) ?? { lon: 0, lat: 0, p: 0, np: 0, n: 0 };
          s.lon += lon; s.lat += lat; s.n++;
          if (p != null) { s.p += p; s.np++; }
          byTau.set(t, s);
        }
      }
      const meanPts = [...byTau.entries()].filter(([, s]) => s.n >= Math.max(2, perts.length / 3))
        .sort((x, y) => x[0] - y[0])
        .map(([t, s]) => ({ tau: t, lon: s.lon / s.n, lat: s.lat / s.n, p: s.np ? Math.round((s.p / s.np) * 10) / 10 : null, n: s.n }));
      if (c.mean && meanPts.length > 1) {
        mean.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: meanPts.map((q) => [q.lon, q.lat]) }, properties: { ...props, kind: 'mean' } });
        for (const q of meanPts) {
          mean.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [q.lon, q.lat] },
            properties: { ...props, kind: 'meanpt', model, init, tau: q.tau, valid: addMin(initStamp(init), q.tau * 60), lat: q.lat, lon: q.lon, p: q.p, n: q.n } });
        }
      }
      if (this.opts.start && meanPts.length && (c.mean || c.members)) {
        mean.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [meanPts[0].lon, meanPts[0].lat] }, properties: { ...props, kind: 'start' } });
      }
    }

    // 實際路徑(氣象署定位):有效時間模式裁到同一時間窗;預報時距模式畫最早初始時間之後的全部
    if (this.visible && this.opts.best && this.bestTrack) {
      const inits = Object.values(this.resolved).map(initStamp);
      let lo, hi;
      if (this.mode === 'valid') { lo = this.windowStart(); hi = lo && addMin(lo, this.validHours * 60); }
      else if (inits.length) { lo = inits.reduce((x, y) => (x < y ? x : y)); hi = '999999999999'; }
      const bt = this.bestTrack.filter((p) => lo && p.t >= lo && p.t <= hi);
      if (bt.length > 1) best.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: bt.map((p) => [p.lon, p.lat]) }, properties: {} });
      bt.forEach((p) => best.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] }, properties: { t: p.t } }));
    }

    const fc = (features) => ({ type: 'FeatureCollection', features });
    this.map.getSource('ens-members').setData(fc(members));
    this.map.getSource('ens-mean').setData(fc(mean));
    this.map.getSource('ens-best').setData(fc(best));
  }

  setBestTrack(points) { this.bestTrack = points; }

  setVisible(v) { this.visible = v; this.draw(); }

  /** 有效時間下拉選單的候選:最早初始時間 ~ 最晚初始時間 + 10 天,每 6 小時 */
  validChoices() {
    if (!this.times.length) return [];
    const out = [];
    for (let t = this.times[0]; t <= addMin(this.latest, 240 * 60); t = addMin(t, 360)) out.push(t);
    return out;
  }
}

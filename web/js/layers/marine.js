// 海象圖層:浮標站、潮位站等海況(pipeline/fetch_marine.py,O-B0075-001,每小時一筆)
// 圓點依色階上色;浪、風、海流有方向時畫箭頭;點站打開資訊卡,看近 48 小時折線圖(marine/recent.json.gz)
import { getIndex, getJSON } from '../data.js';
import { beaufort, beaufortLegendHTML, bfLabel, legendHTML, SCALES, stepExpr } from '../colormaps.js';
import { diffMin, fmtTW, latestLE } from '../time.js';
import { arrowImage } from './stations.js';

// dir:方向欄位;flip:資料是「來的方向」(浪、風)→ 箭頭畫成去的方向;海流本來就是流去的方向
export const MARINE_VARS = {
  wave_h: { name: '浪高', unit: 'm', scale: 'wave', dir: 'wave_dir', flip: true, d: 1 },
  wave_per: { name: '波浪週期', unit: 's', scale: 'period', d: 1 },
  tide: { name: '潮高', unit: 'm', scale: 'tide', d: 2 },
  sst: { name: '海溫', unit: '°C', scale: 'temp', d: 1 },
  ws: { name: '風速', unit: 'm/s', scale: 'wind', dir: 'wd', flip: true, d: 1 },
  gust: { name: '最大陣風', unit: 'm/s', scale: 'wind', d: 1 },
  cur_spd: { name: '海流（表層）', unit: 'm/s', scale: 'current', dir: 'cur_dir', flip: false, d: 2 },
  temp: { name: '氣溫', unit: '°C', scale: 'temp', d: 1 },
  pres: { name: '氣壓', unit: 'hPa', scale: 'pres', d: 1 },
};
export const MARINE_TYPES = { buoy: '資料浮標', tide: '潮位站', coast: '岸邊氣象站', wave: '波浪站' };

// 浪級(浪高 m 的下界);1 m 以下不標浪級
export const WAVE_CLASSES = [[1, '小浪'], [2, '中浪'], [3, '大浪'], [6, '巨浪']];
export const waveClass = (h) => [...WAVE_CLASSES].reverse().find(([lo]) => h >= lo)?.[1] ?? '';

const CACHE_MAX = 60;
const LABEL_ZOOM = 7;
const EMPTY = { type: 'FeatureCollection', features: [] };
const IDS = ['mr-pt', 'mr-arrow', 'mr-sel'];
const fmt = (x, d = 1) => (x == null ? '—' : (+x).toFixed(d));

export class MarineLayer {
  key = 'marine';
  name = '海象';
  path = 'marine';
  cadence = null;            // 每小時一筆:時間軸 10 分鐘一格,顯示該整點起 1 小時內
  visible = true;
  opacity = 1;
  variable = 'wave_h';
  staleMin = 90;             // 不同步時,最新資料超過幾分鐘標成過時(每小時一筆,上架約晚 20–40 分)
  index = null;
  current = null;
  cache = new Map();
  markers = [];
  showLabels = true;
  all = new Map();           // 站號 → 基本資料
  snap = null;               // 目前顯示的快照(資訊卡用)
  selected = null;
  onSelect = null;

  constructor(map) { this.map = map; }

  get v() { return MARINE_VARS[this.variable]; }
  get times() { return this.index?.times ?? []; }
  get latest() { return this.index?.latest ?? null; }

  async load() { this.index = await getIndex(this.path); }

  addTo(beforeId) {
    const m = this.map;
    if (!m.hasImage('st-arrow')) m.addImage('st-arrow', arrowImage(), { sdf: true });
    m.addSource('marine', { type: 'geojson', data: EMPTY });
    m.addLayer({ id: 'mr-pt', type: 'circle', source: 'marine', filter: ['!', ['has', 'dir']],
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 4, 10, 8], 'circle-color': '#888',
        'circle-stroke-color': '#000', 'circle-stroke-width': 1.2 } }, beforeId);
    m.addLayer({ id: 'mr-arrow', type: 'symbol', source: 'marine', filter: ['has', 'dir'],
      layout: { 'icon-image': 'st-arrow', 'icon-rotate': ['get', 'dir'], 'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true, 'icon-size': ['interpolate', ['linear'], ['zoom'], 5, 0.45, 10, 0.9] },
      paint: { 'icon-color': '#888', 'icon-halo-color': '#000', 'icon-halo-width': 1.2 } }, beforeId);
    m.addLayer({ id: 'mr-sel', type: 'circle', source: 'marine', filter: ['==', ['get', 'id'], ''],
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 10, 10, 16], 'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': '#00e5ff', 'circle-stroke-width': 3 } }, beforeId);
    this.applyStyle();
    this.setVisible(this.visible);

    this.popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 8 });
    for (const id of ['mr-pt', 'mr-arrow']) {
      m.on('mousemove', id, (e) => {
        m.getCanvas().style.cursor = 'pointer';
        this.popup.setLngLat(e.features[0].geometry.coordinates).setHTML(this.popupHTML(e.features[0].properties.id)).addTo(m);
      });
      m.on('mouseleave', id, () => { m.getCanvas().style.cursor = ''; this.popup.remove(); });
      m.on('click', id, (e) => this.onSelect?.(e.features[0].properties.id));
    }
    m.on('moveend', () => this.drawLabels());
  }

  applyStyle() {
    const color = stepExpr(SCALES[this.v.scale]);
    this.map.setPaintProperty('mr-pt', 'circle-color', color);
    this.map.setPaintProperty('mr-arrow', 'icon-color', color);
  }

  async configure({ variable = this.variable }) {
    this.variable = variable;
    this.applyStyle();
    this.current = null;
  }

  /** 同步:時間軸所在整點(之前 1 小時內最近的一筆) */
  pick(T, sync) {
    if (!sync) return this.latest;
    const t = latestLE(this.times, T);
    return t && diffMin(T, t) < 60 ? t : null;
  }

  fetch(path) {
    if (!this.cache.has(path)) {
      const p = getJSON(path);
      p.catch(() => this.cache.delete(path));
      this.cache.set(path, p);
      if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value);
    }
    return this.cache.get(path);
  }

  select(id) {
    this.selected = id;
    if (this.map.getLayer('mr-sel')) this.map.setFilter('mr-sel', ['==', ['get', 'id'], id ?? '']);
  }

  async features(stamp) {
    const snap = await this.fetch(`${this.path}/${stamp}.json`);
    const f = Object.fromEntries(snap.fields.map((k, i) => [k, i]));
    const v = this.v, out = [];
    this.snap = { time: snap.time, f, rows: new Map(snap.rows.map((r) => [r[f.id], r])) };
    for (const r of snap.rows) {
      const base = { id: r[f.id], name: r[f.name], type: r[f.type], county: r[f.county] ?? '', area: r[f.area] ?? '',
        lon: r[f.lon], lat: r[f.lat] };
      this.all.set(base.id, base);
      const x = r[f[this.variable]];
      if (x == null) continue;
      const props = { id: base.id, v: x };
      const dir = v.dir ? r[f[v.dir]] : null;
      if (dir != null && x > 0) props.dir = v.flip ? (dir + 180) % 360 : dir;
      out.push({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [base.lon, base.lat] } });
    }
    return { stamp, features: out };
  }

  async show(stamp) {
    const key = `${stamp}|${this.variable}`;
    if (stamp && this.current?.key === key) return;
    this.wanted = key;
    const src = this.map.getSource('marine');
    if (!stamp) {
      src.setData(EMPTY);
      this.current = null;
      this.snap = null;
      this.drawLabels();
      return;
    }
    const d = await this.features(stamp);
    if (this.wanted !== key) return;
    src.setData({ type: 'FeatureCollection', features: d.features });
    this.current = { key, ...d };
    this.drawLabels();
  }

  async prefetch(stamps, onProgress) {
    const hours = [...new Set(stamps.map((t) => latestLE(this.times, t)).filter(Boolean))];
    let done = 0;
    await Promise.all(hours.map((t) => this.fetch(`${this.path}/${t}.json`).catch(() => {})
      .then(() => onProgress?.(++done, hours.length))));
  }

  valText(x, v = this.v) {
    return `${fmt(x, v.d)} ${v.unit}${v.scale === 'wind' ? `（${bfLabel(x)} 級）` : ''}`;
  }

  drawLabels() {
    for (const mk of this.markers) mk.remove();
    this.markers = [];
    if (!this.visible || !this.showLabels || !this.current || this.map.getZoom() < LABEL_ZOOM) return;
    const b = this.map.getBounds();
    for (const ft of this.current.features) {
      const [lon, lat] = ft.geometry.coordinates;
      if (!b.contains([lon, lat])) continue;
      const el = document.createElement('div');
      el.className = 'st-label';
      const x = ft.properties.v;
      el.textContent = fmt(x, this.v.d) + (this.v.scale === 'wind' ? `｜${bfLabel(x)}級`
        : this.variable === 'wave_h' && waveClass(x) ? `｜${waveClass(x)}` : '');
      this.markers.push(new maplibregl.Marker({ element: el, anchor: 'left', offset: [9, 0], opacity: String(this.opacity) }).setLngLat([lon, lat]).addTo(this.map));
    }
  }

  /** 這一站在目前快照的所有觀測(popup 與資訊卡共用) */
  readings(id) {
    const r = this.snap?.rows.get(id);
    if (!r) return null;
    const f = this.snap.f, g = (k) => (f[k] == null ? null : r[f[k]]);
    const deg = (k) => (g(k) == null ? '' : `，${Math.round(g(k))}°`);
    const out = [];
    if (g('wave_h') != null) {
      const c = waveClass(g('wave_h'));
      out.push(['浪高', `${fmt(g('wave_h'))} m${c ? `（${c}）` : ''}${deg('wave_dir')}`]);
    }
    if (g('wave_per') != null) out.push(['週期', `${fmt(g('wave_per'))} s`]);
    if (g('tide') != null) out.push(['潮高', `${fmt(g('tide'), 2)} m${g('tide_lv') ? `（${g('tide_lv')}）` : ''}`]);
    if (g('sst') != null) out.push(['海溫', `${fmt(g('sst'))} °C`]);
    if (g('ws') != null) out.push(['風速', `${fmt(g('ws'))} m/s（${bfLabel(g('ws'))} 級）${deg('wd')}`]);
    if (g('gust') != null) out.push(['最大陣風', `${fmt(g('gust'))} m/s（${bfLabel(g('gust'))} 級）`]);
    if (g('cur_spd') != null) out.push(['海流', `${fmt(g('cur_spd'), 2)} m/s${deg('cur_dir')}`]);
    if (g('temp') != null) out.push(['氣溫', `${fmt(g('temp'))} °C`]);
    if (g('pres') != null) out.push(['氣壓', `${fmt(g('pres'))} hPa`]);
    return out;
  }

  popupHTML(id) {
    const s = this.all.get(id), rows = this.readings(id) ?? [];
    return `<div class="popup-title">${s.name}（${s.id}）</div>
      <div>${MARINE_TYPES[s.type] ?? ''}　${s.area}</div>
      ${rows.map(([k, x]) => `<div>${k}：<b>${x}</b></div>`).join('')}
      <div style="color:var(--muted)">觀測 ${fmtTW(this.snap.time)}（每小時）</div>`;
  }

  setOpacity(v) {
    this.opacity = v;
    const m = this.map;
    m.setPaintProperty('mr-pt', 'circle-opacity', v);
    m.setPaintProperty('mr-pt', 'circle-stroke-opacity', v);
    m.setPaintProperty('mr-arrow', 'icon-opacity', v);
    for (const mk of this.markers) mk.setOpacity(String(v));
  }

  setVisible(v) {
    this.visible = v;
    if (this.map.getLayer('mr-pt')) for (const id of IDS) this.map.setLayoutProperty(id, 'visibility', v ? 'visible' : 'none');
    if (!v) this.popup?.remove();
    this.drawLabels();
  }

  legend() {
    const s = SCALES[this.v.scale];
    if (this.v.scale === 'wind') return beaufortLegendHTML(`海象 ${this.v.name}（蒲福風級）`, s.colors);
    const arrow = this.v.dir ? `；箭頭 = ${this.v.flip ? '前進' : '流去'}方向` : '';
    const html = legendHTML(`海象 ${this.v.name} (${this.v.unit})${arrow}`, s.levels, s.colors, 0, 22, s.ticks);
    if (this.variable !== 'wave_h') return html;
    const cls = WAVE_CLASSES.map(([lo, name], i) => `${name} ${lo}${WAVE_CLASSES[i + 1] ? `–${WAVE_CLASSES[i + 1][0]}` : ' 以上'}`);
    return `${html}<div class="legend-labels" style="margin-top:4px">${cls.join('｜')} m</div>`;
  }
}

// ── 資訊卡:當下各項觀測 + 近 48 小時折線圖 ──
const REFETCH_MS = 5 * 60e3;
const toSec = (s) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12)) / 1000;
const TABS = {
  wave: { name: '浪', series: [{ key: 'wave_h', label: '浪高', unit: 'm', stroke: '#1e88e5', zero: true },
    { key: 'wave_per', label: '週期', unit: 's', stroke: '#ab47bc', scale: 'per' }] },
  tide: { name: '潮位', series: [{ key: 'tide', label: '潮高', unit: 'm', stroke: '#26a69a' }] },
  wind: { name: '風', series: [{ key: 'ws', label: '風速', unit: 'm/s', stroke: '#26a69a', wind: true },
    { key: 'gust', label: '最大陣風', unit: 'm/s', stroke: '#ffca28', wind: true }] },
  temp: { name: '溫度', series: [{ key: 'sst', label: '海溫', unit: '°C', stroke: '#1e88e5' },
    { key: 'temp', label: '氣溫', unit: '°C', stroke: '#ff7043' }] },
  cur: { name: '海流', series: [{ key: 'cur_spd', label: '表層流速', unit: 'm/s', stroke: '#5c6bc0', zero: true }] },
  pres: { name: '氣壓', series: [{ key: 'pres', label: '氣壓', unit: 'hPa', stroke: '#ab47bc' }] },
};
const VAR_TAB = { wave_h: 'wave', wave_per: 'wave', tide: 'tide', ws: 'wind', gust: 'wind', sst: 'temp', temp: 'temp',
  cur_spd: 'cur', pres: 'pres' };

export class MarineCard {
  el = document.getElementById('mr-card');
  id = null;
  tab = 'wave';
  T = null;
  plot = null;
  recent = null;             // { at, promise }

  constructor(layer) {
    this.layer = layer;
    this.el.querySelector('#mc-close').onclick = () => this.close();
    const tabs = this.el.querySelector('.sc-tabs');
    tabs.innerHTML = Object.entries(TABS).map(([k, t]) => `<button data-tab="${k}">${t.name}</button>`).join('');
    for (const b of tabs.querySelectorAll('[data-tab]')) b.onclick = () => { this.tab = b.dataset.tab; this.drawChart(); };
  }

  series() {
    if (!this.recent || Date.now() - this.recent.at > REFETCH_MS) {
      const promise = getJSON('marine/recent.json.gz');
      promise.catch(() => { this.recent = null; });
      this.recent = { at: Date.now(), promise };
    }
    return this.recent.promise;
  }

  async open(id, T) {
    if (!this.layer.all.get(id)) return;
    this.id = id;
    this.T = T;
    this.tab = VAR_TAB[this.layer.variable] ?? this.tab;
    this.el.hidden = false;
    this.layer.select(id);
    this.update(T);
    await this.drawChart();
  }

  close() {
    this.el.hidden = true;
    this.id = null;
    this.plot?.destroy();
    this.plot = null;
    this.layer.select(null);
  }

  update(T) {
    if (!this.id) return;
    this.T = T;
    const s = this.layer.all.get(this.id);
    this.el.querySelector('#mc-title').textContent = `${s.name}（${s.id}）`;
    this.el.querySelector('#mc-sub').textContent = `${s.county}　${MARINE_TYPES[s.type] ?? ''}　${s.area}`;
    const rows = this.layer.readings(this.id), now = this.el.querySelector('#mc-now');
    now.innerHTML = rows?.length
      ? rows.map(([k, x]) => `<div><span>${k}</span><b>${x}</b></div>`).join('') + `<div class="sc-obs">觀測 ${fmtTW(this.layer.snap.time)}</div>`
      : `<div class="sc-nodata">${T ? fmtTW(T) : ''} 這個站沒有資料</div>`;
    this.plot?.redraw(false);
  }

  async drawChart() {
    const box = this.el.querySelector('#mc-chart'), note = this.el.querySelector('#mc-note'), id = this.id;
    let d;
    try {
      d = await this.series();
    } catch {
      box.innerHTML = '<div class="sc-nodata">時序資料尚未產生</div>';
      return;
    }
    if (this.id !== id) return;
    const st = d.stations[id] ?? {};
    // 只留這個站有資料的分頁
    for (const b of this.el.querySelectorAll('[data-tab]')) {
      b.hidden = !TABS[b.dataset.tab].series.some((s) => st[s.key]);
    }
    if (!TABS[this.tab].series.some((s) => st[s.key])) {
      this.tab = Object.keys(TABS).find((k) => TABS[k].series.some((s) => st[s.key])) ?? this.tab;
    }
    for (const b of this.el.querySelectorAll('[data-tab]')) b.classList.toggle('on', b.dataset.tab === this.tab);
    const tab = TABS[this.tab];
    this.plot?.destroy();
    this.plot = null;
    box.innerHTML = '';
    const used = tab.series.filter((s) => st[s.key]);
    if (!used.length) {
      box.innerHTML = '<div class="sc-nodata">這個站近 48 小時沒有資料</div>';
      note.textContent = '';
      return;
    }
    note.textContent = `近 48 小時（至 ${fmtTW(d.time)}），每小時一筆；斷開處為缺漏`;
    const t0 = toSec(d.start), xs = Array.from({ length: d.n }, (_, i) => t0 + i * d.step * 60);
    const axisStyle = { stroke: '#9aa3b2', grid: { stroke: 'rgba(255,255,255,0.08)' }, ticks: { stroke: 'rgba(255,255,255,0.15)' } };
    const series = [{ label: '時間', value: (u, v) => (v == null ? '—' : fmtTW(stampOf(v))) }], data = [xs], scales = { x: { time: true } };
    const tick = (t) => { const s = fmtTW(stampOf(t), 'dh'); return s.endsWith('00時') ? s.replace('00時', '') : s.replace(/^\d+日/, ''); };
    const axes = [{ ...axisStyle, space: 45, values: (u, ticks) => ticks.map(tick) }];
    for (const s of used) {
      series.push({ label: s.label, stroke: s.stroke, width: 1.6, scale: s.scale ?? 'y', points: { show: true, size: 4 },
        value: (u, v) => (v == null ? '—' : s.wind ? `${v.toFixed(1)}（${bfLabel(v)}級）`
          : s.key === 'wave_h' && waveClass(v) ? `${v} m（${waveClass(v)}）` : `${v} ${s.unit}`) });
      data.push(st[s.key]);
      // 浪高、流速從 0 起畫(浪高至少到 3 m,看得到小浪、中浪分界)
      scales[s.scale ?? 'y'] ??= s.zero ? { auto: true, range: (u, lo, hi) => [0, Math.max(hi * 1.1, s.key === 'wave_h' ? 3 : 0.5)] } : { auto: true };
    }
    axes.push({ ...axisStyle, scale: 'y', label: used[0].scale ? '' : used[0].unit, size: 50 });
    if (scales.per) axes.push({ ...axisStyle, scale: 'per', side: 1, label: '週期 s', grid: { show: false }, size: 45 });
    const cardT = () => this.T, waveTab = this.tab === 'wave';
    this.plot = new uPlot({
      width: box.clientWidth || 400, height: 220, series, scales, axes,
      tzDate: (ts) => uPlot.tzDate(new Date(ts * 1e3), 'Asia/Taipei'),
      cursor: { drag: { x: false, y: false } },
      legend: { live: true },
      hooks: {
        draw: [(u) => {
          const c = u.ctx, { left, top, width, height } = u.bbox;
          if (waveTab) {                                  // 浪級分界:虛線 + 浪級名稱
            c.save();
            c.setLineDash([4 * devicePixelRatio, 4 * devicePixelRatio]);
            c.lineWidth = devicePixelRatio;
            c.font = `${10 * devicePixelRatio}px sans-serif`;
            c.textBaseline = 'bottom';
            for (const [lo, name] of WAVE_CLASSES) {
              const y = u.valToPos(lo, 'y', true);
              if (y < top || y > top + height) continue;
              c.strokeStyle = c.fillStyle = 'rgba(154,163,178,0.8)';
              c.beginPath(); c.moveTo(left, y); c.lineTo(left + width, y); c.stroke();
              c.fillText(name, left + 3 * devicePixelRatio, y - devicePixelRatio);
            }
            c.restore();
          }
          const T = cardT();                              // 時間軸目前時間 = 直線
          if (!T) return;
          const x = u.valToPos(toSec(T), 'x', true);
          if (x < left || x > left + width) return;
          c.save();
          c.strokeStyle = '#00e5ff';
          c.lineWidth = 1.5 * devicePixelRatio;
          c.beginPath(); c.moveTo(x, top); c.lineTo(x, top + height); c.stroke();
          c.restore();
        }],
      },
    }, data, box);
  }
}

function stampOf(sec) {
  const d = new Date(sec * 1000), p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

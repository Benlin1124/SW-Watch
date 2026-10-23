// 測站圖層:可切換變數;當前值,或過去 1–72 小時最大 / 最小(pipeline/station_agg.py 預先算好)
// 圓點依色階上色;風速、陣風改畫箭頭(指向風吹去的方向);放大後在點旁標數值(HTML marker,不需字型檔)
import { getIndex, getJSON } from '../data.js';
import { beaufort, beaufortLegendHTML, legendHTML, SCALES, stepExpr } from '../colormaps.js';
import { fmtTW, latestLE } from '../time.js';

export const STATION_VARS = {
  temp: { name: '溫度', unit: '°C', scale: 'temp', agg: true },
  tmax: { name: '今日最高溫', unit: '°C', scale: 'temp' },
  tmin: { name: '今日最低溫', unit: '°C', scale: 'temp' },
  rh: { name: '相對濕度', unit: '%', scale: 'rh', agg: true },
  pres: { name: '氣壓', unit: 'hPa', scale: 'pres', agg: true },
  ws: { name: '風速', unit: 'm/s', scale: 'wind', agg: true, dir: 'wd' },
  gust: { name: '陣風', unit: 'm/s', scale: 'wind', agg: true, dir: 'gust_dir' },
  rain_10m: { name: '10 分鐘雨量', unit: 'mm', scale: 'rain', agg: true, rain: true },
  rain_1h: { name: '1 小時雨量', unit: 'mm', scale: 'rain', agg: true, rain: true },
  rain_3h: { name: '3 小時雨量', unit: 'mm', scale: 'rain', rain: true },
  rain_6h: { name: '6 小時雨量', unit: 'mm', scale: 'rain', rain: true },
  rain_12h: { name: '12 小時雨量', unit: 'mm', scale: 'rain', rain: true },
  rain_24h: { name: '24 小時雨量', unit: 'mm', scale: 'rain', rain: true },
  rain_48h: { name: '48 小時雨量', unit: 'mm', scale: 'rain', rain: true },
  rain_72h: { name: '72 小時雨量', unit: 'mm', scale: 'rain', rain: true },
  rain_today: { name: '今日累積雨量', unit: 'mm', scale: 'rain', rain: true },
};

const AGG_HOURS = [1, 2, 3, 6, 12, 24, 48, 72];
export const STATION_TYPES = { manned: '局屬站', auto: '自動站', rain: '雨量站', jma: '日本氣象廳' };

/** 站種;舊快照沒有 type 欄位時用站號 / 有無氣象要素推估 */
const stationType = (r, f) => (f.type != null && r[f.type]) || (String(r[f.id]).startsWith('46') ? 'manned'
  : r[f.temp] == null && r[f.rh] == null && r[f.ws] == null ? 'rain' : 'auto');
const CACHE_MAX = 60;
const LABEL_ZOOM = 9;          // 放大到這個等級才標數值
const LABEL_MAX = 500;
const EMPTY = { type: 'FeatureCollection', features: [] };

/** 箭頭圖示(朝北,SDF 才能依數值上色) */
export function arrowImage() {
  const s = 32, c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.beginPath();
  g.moveTo(16, 2); g.lineTo(25, 15); g.lineTo(19, 14); g.lineTo(19, 30);
  g.lineTo(13, 30); g.lineTo(13, 14); g.lineTo(7, 15); g.closePath();
  g.fill();
  return g.getImageData(0, 0, s, s);
}

export class StationLayer {
  key = 'stations';
  name = '測站';
  path = 'stations';
  cadence = 10;
  visible = true;
  opacity = 1;
  variable = 'temp';
  stat = 'now';            // now | max | min
  hours = 1;
  index = null;            // 快照的 index
  aggIndex = {};           // hours → index
  current = null;          // { stamp, features, agg }
  cache = new Map();       // path → Promise<JSON>
  markers = [];
  filter = { countyOff: new Set(), types: new Set(Object.keys(STATION_TYPES)) };   // 不顯示的縣市(新出現的縣市預設顯示)、站種
  showLabels = true;       // 地圖上測站旁的數值文字
  all = new Map();         // 站號 → 基本資料(不受篩選、不管有沒有值;搜尋用)
  snap = null;             // 目前時間的快照(資訊卡顯示各變數當前值)
  selected = null;         // 點選中的站號
  onSelect = null;         // 點測站時呼叫(站號)

  constructor(map) { this.map = map; }

  get filterKey() { return `${[...this.filter.countyOff].sort().join(',')}|${[...this.filter.types].sort().join(',')}`; }

  passes(p) { return !this.filter.countyOff.has(p.county) && this.filter.types.has(p.type); }

  setFilter(f) { Object.assign(this.filter, f); this.current = null; }

  /** 目前畫面(含篩選)的站依數值排序;order 'desc' 大到小 */
  ranking(n = 10, order = 'desc') {
    const list = [...(this.current?.features ?? [])].map((ft) => ft.properties);
    list.sort((a, b) => (order === 'desc' ? b.v - a.v : a.v - b.v));
    return list.slice(0, n);
  }

  select(id) {
    this.selected = id;
    if (this.map.getLayer('st-sel')) this.map.setFilter('st-sel', ['==', ['get', 'id'], id ?? '']);
  }

  get v() { return STATION_VARS[this.variable]; }
  get aggMode() { return this.stat !== 'now' && this.v.agg; }
  get aggPath() { return `${this.path}/agg_${this.hours}h`; }
  get activeIndex() { return this.aggMode ? this.aggIndex[this.hours] : this.index; }
  get times() { return this.activeIndex?.times ?? []; }
  get latest() { return this.activeIndex?.latest ?? null; }

  async load() {
    const [idx, agg] = await Promise.all([
      getIndex(this.path),
      getIndex(this.aggPath).catch(() => null),
    ]);
    this.index = idx;
    if (agg) this.aggIndex[this.hours] = agg;
  }

  addTo(beforeId) {
    const m = this.map;
    if (!m.hasImage('st-arrow')) m.addImage('st-arrow', arrowImage(), { sdf: true });
    m.addSource('stations', { type: 'geojson', data: EMPTY });
    m.addLayer({ id: 'st-zero', type: 'circle', source: 'stations', filter: ['==', ['get', 'v'], 0],
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 1.5, 10, 3], 'circle-color': '#9e9e9e', 'circle-opacity': 0.7 } }, beforeId);
    m.addLayer({ id: 'st-pt', type: 'circle', source: 'stations', filter: ['all', ['>', ['get', 'v'], 0], ['!', ['has', 'dir']]],
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 3.5, 10, 7], 'circle-color': '#888',
        'circle-stroke-color': '#333', 'circle-stroke-width': 0.6 } }, beforeId);
    m.addLayer({ id: 'st-arrow', type: 'symbol', source: 'stations', filter: ['has', 'dir'],
      layout: { 'icon-image': 'st-arrow', 'icon-rotate': ['get', 'dir'], 'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true, 'icon-size': ['interpolate', ['linear'], ['zoom'], 6, 0.28, 9, 0.5, 12, 0.8] },
      paint: { 'icon-color': '#888', 'icon-halo-color': '#333', 'icon-halo-width': 0.6 } }, beforeId);
    m.addLayer({ id: 'st-sel', type: 'circle', source: 'stations', filter: ['==', ['get', 'id'], ''],
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 9, 10, 15], 'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': '#00e5ff', 'circle-stroke-width': 3 } }, beforeId);
    this.applyStyle();

    this.popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 8 });
    for (const id of ['st-pt', 'st-arrow', 'st-zero']) {
      m.on('mousemove', id, (e) => {
        m.getCanvas().style.cursor = 'pointer';
        this.popup.setLngLat(e.features[0].geometry.coordinates).setHTML(this.popupHTML(e.features[0].properties)).addTo(m);
      });
      m.on('mouseleave', id, () => { m.getCanvas().style.cursor = ''; this.popup.remove(); });
      m.on('click', id, (e) => this.onSelect?.(e.features[0].properties.id));
    }
    m.on('moveend', () => this.drawLabels());
  }

  applyStyle() {
    const color = stepExpr(SCALES[this.v.scale]);
    this.map.setPaintProperty('st-pt', 'circle-color', color);
    this.map.setPaintProperty('st-arrow', 'icon-color', color);
    // 雨量 0 畫小灰點(有回報 0 和沒有測站分得出來);其他變數 0 也是正常值
    const rain = !!this.v.rain;
    this.map.setFilter('st-zero', rain ? ['==', ['get', 'v'], 0] : ['==', ['get', 'v'], -9999]);
    this.map.setFilter('st-pt', rain ? ['all', ['>', ['get', 'v'], 0], ['!', ['has', 'dir']]] : ['!', ['has', 'dir']]);
    // 風速、陣風:圓點與箭頭依風級放大,級數高的畫在上面
    const wind = this.v.scale === 'wind';
    const bf = ['get', 'bf'];
    this.map.setPaintProperty('st-pt', 'circle-radius', wind
      ? ['interpolate', ['linear'], ['zoom'], 6, ['+', 2, ['*', 0.4, bf]], 10, ['+', 4, ['*', 0.8, bf]]]
      : ['interpolate', ['linear'], ['zoom'], 6, 3.5, 10, 7]);
    this.map.setLayoutProperty('st-arrow', 'icon-size', wind
      ? ['interpolate', ['linear'], ['zoom'], 6, ['+', 0.18, ['*', 0.045, bf]], 10, ['+', 0.35, ['*', 0.08, bf]]]
      : ['interpolate', ['linear'], ['zoom'], 6, 0.28, 9, 0.5, 12, 0.8]);
    this.map.setLayoutProperty('st-pt', 'circle-sort-key', wind ? bf : 0);
    this.map.setLayoutProperty('st-arrow', 'symbol-sort-key', wind ? bf : 0);
  }

  /** 切換變數 / 統計 / 時數;回傳 true 表示時間軸要重建(換了 index) */
  async configure({ variable = this.variable, stat = this.stat, hours = this.hours }) {
    const before = this.activeIndex;
    Object.assign(this, { variable, stat, hours });
    if (this.aggMode && !this.aggIndex[hours]) {
      this.aggIndex[hours] = await getIndex(this.aggPath).catch(() => null);
    }
    this.applyStyle();
    this.current = null;            // 強制重畫
    return before !== this.activeIndex;
  }

  pick(T, sync) {
    if (!sync) return this.latest;
    return latestLE(this.times, T) === T ? T : null;
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

  async features(stamp) {
    const snap = await this.fetch(`${this.path}/${stamp}.json`);
    const f = Object.fromEntries(snap.fields.map((k, i) => [k, i]));
    const v = this.v;
    let agg = null, val, at;
    if (this.aggMode) {
      agg = await this.fetch(`${this.aggPath}/${stamp}.json.gz`);
      const j = agg.vars.indexOf(this.variable);
      const rows = agg[this.stat];
      const byId = new Map(agg.ids.map((id, i) => [id, rows[i][j]]));
      val = (r) => byId.get(r[f.id]) ?? null;
      // 發生時間(max_t / min_t;舊檔沒有,只有日本站陣風的 gust_t)
      const ts = agg[`${this.stat}_t`];
      const atById = ts ? new Map(agg.ids.map((id, i) => [id, ts[i][j]]))
        : new Map(this.variable === 'gust' && this.stat === 'max' ? Object.entries(agg.gust_t ?? {}) : []);
      at = (r) => atById.get(r[f.id]) ?? null;
    } else {
      val = (r) => r[f[this.variable]];
      at = (r) => (this.variable === 'gust' && f.gust_at != null ? r[f.gust_at] : null);
    }
    const out = [];
    this.snap = { time: snap.time, f, rows: new Map(snap.rows.map((r) => [r[f.id], r])) };
    for (const r of snap.rows) {
      const base = { id: r[f.id], name: r[f.name], county: r[f.county] ?? '', town: r[f.town] ?? '',
        alt: r[f.alt], type: stationType(r, f), lon: r[f.lon], lat: r[f.lat] };
      this.all.set(base.id, base);
      const x = val(r);
      if (x == null || !this.passes(base)) continue;
      const { lon, lat, ...rest } = base;
      const props = { ...rest, obs: v.rain ? snap.time : r[f.obs], v: x };
      // 風向 = 風吹來的方向,箭頭畫成吹去的方向;最大 / 最小沒有對應風向,只畫圓點
      if (v.dir && !agg && r[f[v.dir]] != null && x > 0) props.dir = (r[f[v.dir]] + 180) % 360;
      if (v.scale === 'wind') props.bf = beaufort(x);
      // 發生時間:最大 / 最小的每個變數;當前值只有陣風
      if (at(r)) props.gt = at(r);
      out.push({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [r[f.lon], r[f.lat]] } });
    }
    return { stamp, agg, features: out };
  }

  async show(stamp) {
    const key = `${stamp}|${this.variable}|${this.stat}|${this.hours}|${this.filterKey}`;
    if (stamp && this.current?.key === key) return;
    this.wanted = key;
    const src = this.map.getSource('stations');
    if (!stamp) {
      src.setData(EMPTY);
      this.current = null;
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
    let done = 0;
    const queue = [...stamps];
    const worker = async () => {
      while (queue.length) {
        const s = queue.shift();
        try {
          await this.fetch(`${this.path}/${s}.json`);
          if (this.aggMode) await this.fetch(`${this.aggPath}/${s}.json.gz`);
        } catch { /* 缺檔:播放時顯示無資料 */ }
        onProgress?.(++done, stamps.length);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  }

  fmt(x) {
    return this.v.rain || this.variable === 'pres' || this.variable === 'rh' ? `${x}` : x.toFixed(1);
  }

  /** 發生時間:24 小時以上的區間要帶日期 */
  fmtAt(t) {
    return fmtTW(t, (this.current?.agg?.hours ?? 0) >= 24 ? 'md' : 'hm');
  }

  /** 放大後標數值;只標畫面內的站 */
  drawLabels() {
    for (const mk of this.markers) mk.remove();
    this.markers = [];
    if (!this.visible || !this.showLabels || !this.current || this.map.getZoom() < LABEL_ZOOM) return;
    const b = this.map.getBounds();
    let n = 0;
    for (const ft of this.current.features) {
      const [lon, lat] = ft.geometry.coordinates;
      if (!b.contains([lon, lat]) || (this.v.rain && ft.properties.v === 0)) continue;
      if (++n > LABEL_MAX) break;
      const el = document.createElement('div');
      el.className = 'st-label';
      el.textContent = this.fmt(ft.properties.v) + (this.v.scale === 'wind' ? `｜${beaufort(ft.properties.v)}級` : '')
        + (ft.properties.gt ? ` @${this.fmtAt(ft.properties.gt)}` : '');
      this.markers.push(new maplibregl.Marker({ element: el, anchor: 'left', offset: [7, 0], opacity: String(this.opacity) }).setLngLat([lon, lat]).addTo(this.map));
    }
  }

  popupHTML(p) {
    const v = this.v, agg = this.current?.agg;
    const what = agg ? `過去 ${agg.hours} 小時${this.stat === 'max' ? '最大' : '最小'}${v.name}` : v.name;
    const when = agg ? `${fmtTW(agg.start, agg.hours >= 24 ? 'md' : 'hm')}–${fmtTW(agg.time, 'hm')}` : `觀測 ${fmtTW(p.obs)}`;
    const alt = p.alt != null && p.alt !== 'null' ? `　${p.alt} m` : '';
    return `<div class="popup-title">${p.name}（${p.id}）</div>
      <div>${p.county}${p.town}${alt}</div>
      <div>${what}：<b>${this.fmt(+p.v)}</b> ${v.unit}${v.scale === 'wind' ? `（<b>${beaufort(+p.v)} 級</b>）` : ''}</div>
      ${p.gt ? `<div>發生時間：<b>${fmtTW(p.gt)}</b>（台灣）</div>` : ''}
      <div style="color:var(--muted)">${when}</div>`;
  }

  /** 圖層時間欄:最大 / 最小顯示區間,區間內缺快照就標出來 */
  timeLabel(stamp) {
    const agg = this.current?.agg;
    if (!this.aggMode || !agg || agg.time !== stamp) return null;
    const miss = agg.expected - agg.found;
    return { text: `${fmtTW(agg.start, agg.hours >= 24 ? 'md' : 'hm')}–${fmtTW(stamp)}${miss ? `（缺 ${miss} 筆）` : ''}`, stale: miss > 0 };
  }

  /** 圓點、箭頭、數值標示一起調 */
  setOpacity(v) {
    this.opacity = v;
    const m = this.map;
    m.setPaintProperty('st-pt', 'circle-opacity', v);
    m.setPaintProperty('st-pt', 'circle-stroke-opacity', v);
    m.setPaintProperty('st-zero', 'circle-opacity', 0.7 * v);
    m.setPaintProperty('st-arrow', 'icon-opacity', v);
    for (const mk of this.markers) mk.setOpacity(String(v));
  }

  setVisible(v) {
    this.visible = v;
    for (const id of ['st-pt', 'st-arrow', 'st-zero', 'st-sel']) this.map.setLayoutProperty(id, 'visibility', v ? 'visible' : 'none');
    if (!v) this.popup?.remove();
    this.drawLabels();
  }

  legend() {
    const s = SCALES[this.v.scale];
    const title = this.aggMode ? `${this.v.name} 過去 ${this.hours} 小時${this.stat === 'max' ? '最大' : '最小'}` : this.v.name;
    if (this.v.scale === 'wind') return beaufortLegendHTML(`測站 ${title}（蒲福風級）`, s.colors);
    return legendHTML(`測站 ${title} (${this.v.unit})`, s.levels, s.colors, 0, 22, s.ticks);
  }
}



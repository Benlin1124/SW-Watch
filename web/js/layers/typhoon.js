// 氣象署颱風路徑:過去路徑、預報路徑、70% 潛勢區、7 級 / 10 級暴風圈
// 文字標示用 HTML marker(中文不需要地圖字型檔)
import { getIndex, getJSON } from '../data.js';
import { addMin, fmtTW, latestLE } from '../time.js';

const EMPTY = { type: 'FeatureCollection', features: [] };

// 線條顏色依底圖深淺切換(淺色底圖上白線看不到)
const THEME = {
  light: { track: '#222', fcst: '#000', cone: '#000', coneOp: 0.07, halo: '#fff' },
  dark: { track: '#e0e0e0', fcst: '#fff', cone: '#fff', coneOp: 0.12, halo: '#000' },
};

/** 大圓航線終點(球面近似,暴風圈尺度誤差 < 0.5%) */
function destination(lon, lat, bearing, km) {
  const R = 6371.0088, d = km / R, b = (bearing * Math.PI) / 180;
  const p1 = (lat * Math.PI) / 180, l1 = (lon * Math.PI) / 180;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [(l2 * 180) / Math.PI, (p2 * 180) / Math.PI];
}

/** 暴風圈多邊形;r = 半徑(km)或四象限 [NE, SE, SW, NW] */
function windCircle(lon, lat, r) {
  const ring = [];
  for (let a = 0; a < 360; a += 4) {
    const rr = Array.isArray(r) ? r[Math.min(3, Math.floor(a / 90))] : r;
    ring.push(destination(lon, lat, a, rr));
  }
  ring.push(ring[0]);
  return { type: 'Polygon', coordinates: [ring] };
}

// 氣象署強度分類(近中心最大風速 m/s)
export function category(wind) {
  if (wind == null) return { name: '—', color: '#bdbdbd' };
  if (wind >= 51.0) return { name: '強烈颱風', color: '#e53935' };
  if (wind >= 32.7) return { name: '中度颱風', color: '#fb8c00' };
  if (wind >= 17.2) return { name: '輕度颱風', color: '#fdd835' };
  return { name: '熱帶性低氣壓', color: '#4fc3f7' };
}

const fmtNum = (v, unit) => (v == null ? '—' : `${v}${unit}`);

function popupHTML(name, p, kind) {
  const c = category(p.wind);
  const time = kind === 'past'
    ? `${fmtTW(p.t, 'full')}（實際位置）`
    : `${fmtTW(p.t, 'full')}（+${p.tau} 小時預報）`;
  return `<div class="popup-title">${name}　${c.name}</div>
    <div>${time}</div>
    <div>位置 ${p.lat.toFixed(1)}°N ${p.lon.toFixed(1)}°E</div>
    <div>中心氣壓 ${fmtNum(p.pres, ' hPa')}　最大風速 ${fmtNum(p.wind, ' m/s')}　陣風 ${fmtNum(p.gust, ' m/s')}</div>
    ${p.r15 ? `<div>7 級風暴風半徑 ${p.r15} km${p.r25 ? `　10 級 ${p.r25} km` : ''}</div>` : ''}
    ${p.r70 ? `<div>70% 機率半徑 ${p.r70} km</div>` : ''}
    ${p.mv_dir ? `<div>移動 ${p.mv_dir} ${fmtNum(p.mv_spd, ' km/h')}</div>` : ''}`;
}

export class TyphoonLayer {
  key = 'typhoon';
  name = '颱風路徑';
  path = 'typhoon/cwa_track';
  cadence = null;          // 不定期發布:同步模式取「≤ T 的最近一次發布」
  visible = true;
  show_cone = true;
  circles = { now: true, fcst: true, past: false };   // 暴風圈:目前 / 各預報點 / 過去各定位
  theme = 'light';
  show_labels = true;
  fixedIssue = '';         // 使用者指定的發布時間;空字串 = 依時間軸
  index = null;
  data = null;
  markers = [];
  cache = new Map();

  constructor(map) { this.map = map; }

  get times() { return this.index?.times ?? []; }
  get latest() { return this.index?.latest ?? null; }

  async load() { this.index = await getIndex(this.path); }

  addTo() {
    const m = this.map;
    for (const id of ['ty-cone', 'ty-c15', 'ty-c25', 'ty-past', 'ty-fcst']) m.addSource(id, { type: 'geojson', data: EMPTY });
    const th = THEME[this.theme];
    // 暴風圈:目前位置實心填色;預報點、過去點只畫淡色填色 + 細框,避免整片糊在一起
    const circleFill = (color) => ({ 'fill-color': color, 'fill-opacity': ['match', ['get', 'kind'], 'now', 0.2, 0.04] });
    const circleLine = (color) => ({ 'line-color': color, 'line-width': ['match', ['get', 'kind'], 'now', 1.8, 1], 'line-opacity': ['match', ['get', 'kind'], 'now', 1, 0.75] });
    m.addLayer({ id: 'ty-cone-fill', type: 'fill', source: 'ty-cone', paint: { 'fill-color': th.cone, 'fill-opacity': th.coneOp } });
    m.addLayer({ id: 'ty-cone-line', type: 'line', source: 'ty-cone', paint: { 'line-color': th.cone, 'line-width': 1.2, 'line-dasharray': [3, 2] } });
    m.addLayer({ id: 'ty-c15-fill', type: 'fill', source: 'ty-c15', paint: circleFill('#f9a825') });
    m.addLayer({ id: 'ty-c15-line', type: 'line', source: 'ty-c15', paint: circleLine('#f9a825') });
    m.addLayer({ id: 'ty-c25-fill', type: 'fill', source: 'ty-c25', paint: circleFill('#e53935') });
    m.addLayer({ id: 'ty-c25-line', type: 'line', source: 'ty-c25', paint: circleLine('#e53935') });
    m.addLayer({ id: 'ty-past-line', type: 'line', source: 'ty-past', filter: ['==', '$type', 'LineString'],
      paint: { 'line-color': th.track, 'line-width': 2 } });
    m.addLayer({ id: 'ty-fcst-line', type: 'line', source: 'ty-fcst', filter: ['==', '$type', 'LineString'],
      paint: { 'line-color': th.fcst, 'line-width': 2, 'line-dasharray': [2, 1.5] } });
    m.addLayer({ id: 'ty-past-pt', type: 'circle', source: 'ty-past', filter: ['==', '$type', 'Point'],
      paint: { 'circle-radius': ['case', ['get', 'now'], 7, 3.5], 'circle-color': ['get', 'color'],
        'circle-stroke-color': '#000', 'circle-stroke-width': ['case', ['get', 'now'], 2, 0.8] } });
    m.addLayer({ id: 'ty-fcst-pt', type: 'circle', source: 'ty-fcst', filter: ['==', '$type', 'Point'],
      paint: { 'circle-radius': 4.5, 'circle-color': 'rgba(0,0,0,0.4)', 'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 2 } });

    for (const id of ['ty-past-pt', 'ty-fcst-pt']) {
      m.on('click', id, (e) => {
        const f = e.features[0];
        const p = JSON.parse(f.properties.json);
        new maplibregl.Popup({ maxWidth: '320px' }).setLngLat(f.geometry.coordinates)
          .setHTML(popupHTML(f.properties.name, p, id === 'ty-past-pt' ? 'past' : 'fcst')).addTo(m);
      });
      m.on('mouseenter', id, () => { m.getCanvas().style.cursor = 'pointer'; });
      m.on('mouseleave', id, () => { m.getCanvas().style.cursor = ''; });
    }
  }

  /** 指定發布時間優先;同步取 ≤ T 的最近一次;不同步取最新 */
  pick(T, sync) {
    if (this.fixedIssue) return this.fixedIssue;
    return sync ? latestLE(this.times, T) : this.latest;
  }

  async show(stamp) {
    this.wanted = stamp;
    if (!stamp) { this.data = null; this.draw(); return; }
    if (!this.cache.has(stamp)) this.cache.set(stamp, getJSON(`${this.path}/${stamp}.json`));
    const data = await this.cache.get(stamp);
    if (this.wanted !== stamp) return;
    this.data = data;
    this.draw();
  }

  draw() {
    const storms = this.data?.storms ?? [];
    const cone = [], c15 = [], c25 = [], past = [], fcst = [];
    this.markers.forEach((mk) => mk.remove());
    this.markers = [];

    for (const s of storms) {
      const name = s.name_zh ? `${s.name_zh} ${s.name_en ?? ''}`.trim() : (s.name_en ?? s.id);
      if (s.geo.cone70) cone.push({ type: 'Feature', geometry: s.geo.cone70, properties: {} });

      const pts = s.past;
      if (pts.length > 1) past.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: pts.map((p) => [p.lon, p.lat]) }, properties: {} });
      pts.forEach((p, i) => past.push({
        type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
        properties: { name, now: i === pts.length - 1, color: category(p.wind).color, json: JSON.stringify(p) },
      }));

      const now = pts[pts.length - 1];
      const fp = s.fcst.map((p) => ({ ...p, t: addMin(s.fcst_init, p.tau * 60) }));
      if (now && fp.length) {
        fcst.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[now.lon, now.lat], ...fp.map((p) => [p.lon, p.lat])] }, properties: {} });
      }
      // 暴風圈:過去各定位(有四象限就用四象限)、目前位置、各預報點
      const addCircles = (p, kind) => {
        const r15 = p.r15q ?? p.r15, r25 = p.r25q ?? p.r25;
        if (r15) c15.push({ type: 'Feature', geometry: windCircle(p.lon, p.lat, r15), properties: { kind } });
        if (r25) c25.push({ type: 'Feature', geometry: windCircle(p.lon, p.lat, r25), properties: { kind } });
      };
      if (this.circles.past) pts.slice(0, -1).forEach((p) => addCircles(p, 'past'));
      if (this.circles.now && now) addCircles(now, 'now');
      if (this.circles.fcst) fp.forEach((p) => addCircles(p, 'fcst'));

      fp.forEach((p) => fcst.push({
        type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
        properties: { name, color: category(p.wind).color, json: JSON.stringify(p) },
      }));

      if (!this.visible) continue;
      if (now) this.addMarker([now.lon, now.lat], 'ty-name', name);
      if (this.show_labels) {
        fp.forEach((p) => this.addMarker([p.lon, p.lat], 'ty-label', fmtTW(p.t, 'dh')));
      }
    }

    const fc = (features) => ({ type: 'FeatureCollection', features });
    const m = this.map;
    m.getSource('ty-cone').setData(fc(this.show_cone ? cone : []));
    m.getSource('ty-c15').setData(fc(c15));
    m.getSource('ty-c25').setData(fc(c25));
    m.getSource('ty-past').setData(fc(past));
    m.getSource('ty-fcst').setData(fc(fcst));
  }

  addMarker(lngLat, cls, text) {
    const el = document.createElement('div');
    el.className = cls;
    el.textContent = text;
    this.markers.push(new maplibregl.Marker({ element: el, anchor: 'left' }).setLngLat(lngLat).addTo(this.map));
  }

  setVisible(v) {
    this.visible = v;
    for (const id of ['ty-cone-fill', 'ty-cone-line', 'ty-c15-fill', 'ty-c15-line', 'ty-c25-fill', 'ty-c25-line',
      'ty-past-line', 'ty-fcst-line', 'ty-past-pt', 'ty-fcst-pt']) {
      this.map.setLayoutProperty(id, 'visibility', v ? 'visible' : 'none');
    }
    this.draw();
  }

  storms() { return this.data?.storms ?? []; }

  setTheme(theme) {
    this.theme = theme;
    const th = THEME[theme], m = this.map;
    m.setPaintProperty('ty-cone-fill', 'fill-color', th.cone);
    m.setPaintProperty('ty-cone-fill', 'fill-opacity', th.coneOp);
    m.setPaintProperty('ty-cone-line', 'line-color', th.cone);
    m.setPaintProperty('ty-past-line', 'line-color', th.track);
    m.setPaintProperty('ty-fcst-line', 'line-color', th.fcst);
    document.body.dataset.mapTheme = theme;   // HTML 標示的文字顏色(CSS)
  }

  fitStorm(id) {
    const s = this.storms().find((x) => x.id === id);
    if (!s) return;
    const pts = [...s.past.slice(-8), ...s.fcst];
    const lons = pts.map((p) => p.lon), lats = pts.map((p) => p.lat);
    this.map.fitBounds([[Math.min(...lons) - 3, Math.min(...lats) - 3], [Math.max(...lons) + 3, Math.max(...lats) + 3]],
      { padding: { top: 60, bottom: 80, left: 300, right: 40 }, duration: 800 });
  }
}

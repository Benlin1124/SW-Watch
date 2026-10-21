// 氣象署颱風路徑:過去路徑、預報路徑、70% 潛勢區、7 級 / 10 級暴風圈
// 文字標示用 HTML marker(中文不需要地圖字型檔)
import { getIndex, getJSON } from '../data.js';
import { addMin, fmtTW, latestLE } from '../time.js';

const EMPTY = { type: 'FeatureCollection', features: [] };

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
  show_circle = true;
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
    m.addLayer({ id: 'ty-cone-fill', type: 'fill', source: 'ty-cone', paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.12 } });
    m.addLayer({ id: 'ty-cone-line', type: 'line', source: 'ty-cone', paint: { 'line-color': '#ffffff', 'line-width': 1.2, 'line-dasharray': [3, 2] } });
    m.addLayer({ id: 'ty-c15-fill', type: 'fill', source: 'ty-c15', paint: { 'fill-color': '#ffd54f', 'fill-opacity': 0.15 } });
    m.addLayer({ id: 'ty-c15-line', type: 'line', source: 'ty-c15', paint: { 'line-color': '#ffd54f', 'line-width': 1.5 } });
    m.addLayer({ id: 'ty-c25-fill', type: 'fill', source: 'ty-c25', paint: { 'fill-color': '#ff5252', 'fill-opacity': 0.2 } });
    m.addLayer({ id: 'ty-c25-line', type: 'line', source: 'ty-c25', paint: { 'line-color': '#ff5252', 'line-width': 1.5 } });
    m.addLayer({ id: 'ty-past-line', type: 'line', source: 'ty-past', filter: ['==', '$type', 'LineString'],
      paint: { 'line-color': '#e0e0e0', 'line-width': 2 } });
    m.addLayer({ id: 'ty-fcst-line', type: 'line', source: 'ty-fcst', filter: ['==', '$type', 'LineString'],
      paint: { 'line-color': '#ffffff', 'line-width': 2, 'line-dasharray': [2, 1.5] } });
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
      if (s.geo.circle15) c15.push({ type: 'Feature', geometry: s.geo.circle15, properties: {} });
      if (s.geo.circle25) c25.push({ type: 'Feature', geometry: s.geo.circle25, properties: {} });

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
    m.getSource('ty-c15').setData(fc(this.show_circle ? c15 : []));
    m.getSource('ty-c25').setData(fc(this.show_circle ? c25 : []));
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

  fitStorm(id) {
    const s = this.storms().find((x) => x.id === id);
    if (!s) return;
    const pts = [...s.past.slice(-8), ...s.fcst];
    const lons = pts.map((p) => p.lon), lats = pts.map((p) => p.lat);
    this.map.fitBounds([[Math.min(...lons) - 3, Math.min(...lats) - 3], [Math.max(...lons) + 3, Math.max(...lats) + 3]],
      { padding: { top: 60, bottom: 80, left: 300, right: 40 }, duration: 800 });
  }
}

// 氣象署颱風路徑:過去路徑、預報路徑、70% 潛勢區、7 級 / 10 級暴風圈
// 文字標示用 HTML marker(中文不需要地圖字型檔)
import { getIndex, getJSON } from '../data.js';
import { addMin, fmtTW, latestLE, toDate, toStamp } from '../time.js';

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

/** 暴風圈多邊形;r = 半徑(km)或四象限 [NE, SE, SW, NW]。
 *  四象限:每個象限各畫 0–90° 的圓弧(兩端都畫),象限交界(正北 / 東 / 南 / 西)同一方位角接兩個半徑 → 交界是徑向直線 */
function windCircle(lon, lat, r) {
  const ring = [];
  if (Array.isArray(r)) {
    for (let q = 0; q < 4; q++) for (let a = q * 90; a <= q * 90 + 90; a += 3) ring.push(destination(lon, lat, a, r[q]));
  } else {
    for (let a = 0; a < 360; a += 3) ring.push(destination(lon, lat, a, r));
  }
  ring.push(ring[0]);
  return { type: 'Polygon', coordinates: [ring] };
}

// 氣象署強度分類(近中心最大風速 m/s)
// state(pipeline 由氣象署 StateTransfer 判斷):ext 溫帶氣旋、low 低氣壓、td 熱帶性低氣壓
export function category(wind, state) {
  if (state === 'ext') return { name: '溫帶氣旋', color: '#9e9e9e' };
  if (state === 'low' || (wind == null && state !== 'td')) return { name: '低氣壓', color: '#ffffff' };
  if (wind == null) return { name: '熱帶性低氣壓', color: '#4fc3f7' };
  if (wind >= 51.0) return { name: '強烈颱風', color: '#e53935' };
  if (wind >= 32.7) return { name: '中度颱風', color: '#fb8c00' };
  if (wind >= 17.2) return { name: '輕度颱風', color: '#fdd835' };
  return { name: '熱帶性低氣壓', color: '#4fc3f7' };
}

const fmtNum = (v, unit) => (v == null ? '—' : `${v}${unit}`);

// ── 依時間內插路徑(動畫、點選路徑線用)──
const SCALAR = ['wind', 'gust', 'pres', 'r15', 'r25', 'r70'];
const lerp = (a, b, f) => (a == null || b == null ? null : a + (b - a) * f);
const round = (v) => (v == null ? null : Math.round(v));

/** 兩點之間 f(0–1)的位置、強度、暴風圈;四象限半徑兩端都有才內插 */
function between(a, b, f) {
  if (f <= 0) return { ...a, exact: true };
  if (f >= 1) return { ...b, exact: true };
  const q = { ms: lerp(a.ms, b.ms, f), lon: lerp(a.lon, b.lon, f), lat: lerp(a.lat, b.lat, f), kind: b.kind, init: b.init, exact: false };
  for (const k of SCALAR) q[k] = lerp(a[k], b[k], f);
  q.state = f < 0.5 ? a.state : b.state;
  for (const k of ['r15q', 'r25q']) if (a[k] && b[k]) q[k] = a[k].map((x, i) => lerp(x, b[k][i], f));
  q.t = toStamp(new Date(Math.round(q.ms / 60e3) * 60e3));
  if (q.kind === 'fcst') q.tau = Math.round(((q.ms - toDate(q.init).getTime()) / 36e5) * 10) / 10;
  return q;
}

/** 路徑上時間 ms 的位置;超出範圍回 null */
function at(track, ms) {
  const pts = track.pts;
  if (!pts.length || ms < pts[0].ms || ms > pts[pts.length - 1].ms) return null;
  for (let i = 1; i < pts.length; i++) {
    if (ms <= pts[i].ms) return between(pts[i - 1], pts[i], (ms - pts[i - 1].ms) / (pts[i].ms - pts[i - 1].ms || 1));
  }
  return { ...pts[0], exact: true };
}

function popupHTML(name, p, kind) {
  if (p.exact === false) {
    p = { ...p, wind: round(p.wind), gust: round(p.gust), pres: round(p.pres), r15: round(p.r15), r25: round(p.r25), r70: round(p.r70) };
  }
  const c = category(p.wind, p.state);
  const ip = p.exact === false;
  const time = kind === 'past'
    ? `${fmtTW(p.t, 'full')}（${ip ? '實際路徑內插' : '實際位置'}）`
    : `${fmtTW(p.t, 'full')}（${ip ? '內插，' : ''}+${p.tau} 小時預報）`;
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
  cadence = null;          // 不定期:同步模式取「≤ T 的最近一次預報初始時間」
  visible = true;
  show_cone = true;
  circles = { now: true, fcst: true, past: false };   // 暴風圈:目前 / 各預報點 / 過去各定位
  circleShape = 'quad';    // 暴風圈形狀:quad 四象限(沒有象限資料時用平均)| avg 平均半徑

  /** 某點的 7 級 / 10 級暴風圈半徑:依形狀選四象限或平均 */
  radii(p) {
    const quad = this.circleShape === 'quad';
    return [quad ? p.r15q ?? p.r15 : p.r15, quad ? p.r25q ?? p.r25 : p.r25];
  }
  circleStyle = { nowWidth: 1.8, fcstWidth: 1, nowFill: 20, fcstFill: 4 };   // 線寬(px)、填色濃度(%):目前 / 預報(過去各點同預報)
  theme = 'light';
  show_names = true;       // 目前位置旁的颱風名稱
  show_labels = true;
  fixedIssue = "";         // 使用者指定的預報初始時間;空字串 = 依時間軸
  index = null;
  data = null;
  markers = [];
  cache = new Map();
  tracks = [];             // 各颱風的時間序列(過去定位 + 預報),draw() 重建
  probeMarkers = [];       // 動畫 / 點選位置旁的時間標示
  raf = 0;                 // 動畫 requestAnimationFrame
  animSpeed = 6;           // 動畫速度:每秒走幾小時的預報(不受路徑長短影響)
  animHold = 1500;         // 起點、終點各停留(毫秒)
  onAnim = null;           // 動畫開始 / 停止時呼叫(true / false)

  constructor(map) { this.map = map; }

  widthExpr() { const c = this.circleStyle; return ['match', ['get', 'kind'], 'now', c.nowWidth, c.fcstWidth]; }
  fillExpr() { const c = this.circleStyle; return ['match', ['get', 'kind'], 'now', c.nowFill / 100, c.fcstFill / 100]; }

  /** 暴風圈線寬 / 填色濃度 */
  setCircleStyle(style) {
    Object.assign(this.circleStyle, style);
    for (const k of ['c15', 'c25']) {
      this.map.setPaintProperty(`ty-${k}-line`, 'line-width', this.widthExpr());
      this.map.setPaintProperty(`ty-${k}-fill`, 'fill-opacity', this.fillExpr());
    }
  }

  get times() { return this.index?.times ?? []; }
  get latest() { return this.index?.latest ?? null; }

  async load() { this.index = await getIndex(this.path); }

  addTo() {
    const m = this.map;
    for (const id of ['ty-cone', 'ty-c15', 'ty-c25', 'ty-past', 'ty-fcst']) m.addSource(id, { type: 'geojson', data: EMPTY });
    const th = THEME[this.theme];
    // 暴風圈:目前位置實心填色;預報點、過去點只畫淡色填色 + 細框,避免整片糊在一起
    const circleFill = (color) => ({ 'fill-color': color, 'fill-opacity': this.fillExpr() });
    const circleLine = (color) => ({ 'line-color': color, 'line-width': this.widthExpr(), 'line-opacity': ['match', ['get', 'kind'], 'now', 1, 0.75] });
    m.addLayer({ id: 'ty-cone-fill', type: 'fill', source: 'ty-cone', paint: { 'fill-color': th.cone, 'fill-opacity': th.coneOp } });
    m.addLayer({ id: 'ty-cone-line', type: 'line', source: 'ty-cone', paint: { 'line-color': th.cone, 'line-width': 1.2, 'line-dasharray': [3, 2] } });
    m.addLayer({ id: 'ty-c15-fill', type: 'fill', source: 'ty-c15', paint: circleFill('#f9a825') });
    m.addLayer({ id: 'ty-c15-line', type: 'line', source: 'ty-c15', paint: circleLine('#f9a825') });
    m.addLayer({ id: 'ty-c25-fill', type: 'fill', source: 'ty-c25', paint: circleFill('#e53935') });
    m.addLayer({ id: 'ty-c25-line', type: 'line', source: 'ty-c25', paint: circleLine('#e53935') });
    // 動畫 / 點選位置的 70% 機率圓(同潛勢區樣式)與暴風圈(畫在路徑線下面)
    m.addSource('ty-probe', { type: 'geojson', data: EMPTY });
    const isC70 = ['==', ['get', 'k'], 'c70'];
    m.addLayer({ id: 'ty-probe-c70-fill', type: 'fill', source: 'ty-probe', filter: isC70,
      paint: { 'fill-color': th.cone, 'fill-opacity': th.coneOp * 2 } });
    m.addLayer({ id: 'ty-probe-c70-line', type: 'line', source: 'ty-probe', filter: isC70,
      paint: { 'line-color': th.cone, 'line-width': 1.5, 'line-dasharray': [3, 2] } });
    const isWind = ['all', ['==', ['geometry-type'], 'Polygon'], ['!', isC70]];
    m.addLayer({ id: 'ty-probe-fill', type: 'fill', source: 'ty-probe', filter: isWind,
      paint: { 'fill-color': ['match', ['get', 'k'], 'c25', '#e53935', '#f9a825'], 'fill-opacity': 0.18 } });
    m.addLayer({ id: 'ty-probe-line', type: 'line', source: 'ty-probe', filter: isWind,
      paint: { 'line-color': ['match', ['get', 'k'], 'c25', '#e53935', '#f9a825'], 'line-width': 2 } });
    m.addLayer({ id: 'ty-past-line', type: 'line', source: 'ty-past', filter: ['==', '$type', 'LineString'],
      paint: { 'line-color': th.track, 'line-width': 2 } });
    m.addLayer({ id: 'ty-fcst-line', type: 'line', source: 'ty-fcst', filter: ['==', '$type', 'LineString'],
      paint: { 'line-color': th.fcst, 'line-width': 2, 'line-dasharray': [2, 1.5] } });
    // 路徑線很細,另外疊一條透明粗線方便點選
    for (const k of ['past', 'fcst']) {
      m.addLayer({ id: `ty-${k}-hit`, type: 'line', source: `ty-${k}`, filter: ['==', '$type', 'LineString'],
        paint: { 'line-color': '#000', 'line-width': 14, 'line-opacity': 0 } });
    }
    m.addLayer({ id: 'ty-past-pt', type: 'circle', source: 'ty-past', filter: ['==', '$type', 'Point'],
      paint: { 'circle-radius': ['case', ['get', 'now'], 7, 3.5], 'circle-color': ['get', 'color'],
        'circle-stroke-color': '#000', 'circle-stroke-width': ['case', ['get', 'now'], 2, 0.8] } });
    m.addLayer({ id: 'ty-fcst-pt', type: 'circle', source: 'ty-fcst', filter: ['==', '$type', 'Point'],
      paint: { 'circle-radius': 4.5, 'circle-color': 'rgba(0,0,0,0.4)', 'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 2 } });

    m.addLayer({ id: 'ty-probe-pt', type: 'circle', source: 'ty-probe', filter: ['==', '$type', 'Point'],
      paint: { 'circle-radius': 8, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 2.5 } });

    // 點路徑點 → 那一點;點路徑線 → 依時間內插的位置。都畫出當時的暴風圈
    const PT = ['ty-past-pt', 'ty-fcst-pt'], HIT = ['ty-past-hit', 'ty-fcst-hit'];
    m.on('click', (e) => {
      if (!this.visible) return;
      const hits = m.queryRenderedFeatures(e.point, { layers: [...PT, ...HIT] });
      if (!hits.length) return;
      const pt = hits.find((f) => PT.includes(f.layer.id));
      let name, q, kind;
      if (pt) {
        name = pt.properties.name;
        q = { ...JSON.parse(pt.properties.json), exact: true };
        kind = pt.layer.id === 'ty-past-pt' ? 'past' : 'fcst';
      } else {
        const near = this.nearest(e.point);
        if (!near) return;
        ({ name, q } = near);
        kind = q.kind;
      }
      this.animate(false);
      this.popup?.remove();          // 先關舊的(關閉時會清掉暴風圈)再畫新的
      this.setProbe([{ name, q }], false);
      this.popup = new maplibregl.Popup({ maxWidth: '320px' }).setLngLat([q.lon, q.lat])
        .setHTML(popupHTML(name, q, kind)).addTo(m);
      this.popup.on('close', () => { if (!this.raf) this.setProbe([]); });
    });
    for (const id of [...PT, ...HIT]) {
      m.on('mouseenter', id, () => { m.getCanvas().style.cursor = 'pointer'; });
      m.on('mouseleave', id, () => { m.getCanvas().style.cursor = ''; });
    }
  }

  /** 螢幕座標 point 最近的路徑位置(投影到各段,依比例內插時間) */
  nearest(point) {
    let best = null;
    for (const tr of this.tracks) {
      const px = tr.pts.map((p) => this.map.project([p.lon, p.lat]));
      for (let i = 1; i < px.length; i++) {
        const a = px[i - 1], b = px[i], dx = b.x - a.x, dy = b.y - a.y;
        const u = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
        const d = Math.hypot(a.x + u * dx - point.x, a.y + u * dy - point.y);
        if (!best || d < best.d) best = { d, tr, q: between(tr.pts[i - 1], tr.pts[i], u) };
      }
    }
    return best && { name: best.tr.name, q: best.q };
  }

  /** 動畫 / 點選位置:圓點、暴風圈、時間標示;list = [{ name, q }] */
  setProbe(list, label = true, cone = true) {
    const feats = [];
    for (const { q } of list) {
      const [r15, r25] = this.radii(q);
      if (cone && this.show_cone && q.r70 > 0) feats.push({ type: 'Feature', geometry: windCircle(q.lon, q.lat, q.r70), properties: { k: 'c70' } });
      if (r15) feats.push({ type: 'Feature', geometry: windCircle(q.lon, q.lat, r15), properties: { k: 'c15' } });
      if (r25) feats.push({ type: 'Feature', geometry: windCircle(q.lon, q.lat, r25), properties: { k: 'c25' } });
      feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [q.lon, q.lat] }, properties: { color: category(q.wind, q.state).color } });
    }
    this.map.getSource('ty-probe')?.setData({ type: 'FeatureCollection', features: feats });
    const shown = label ? list : [];
    while (this.probeMarkers.length > shown.length) this.probeMarkers.pop().remove();
    shown.forEach(({ name, q }, i) => {
      if (!this.probeMarkers[i]) {
        const el = document.createElement('div');
        el.className = 'ty-label ty-probe-label';
        this.probeMarkers[i] = new maplibregl.Marker({ element: el, anchor: 'left' }).setLngLat([q.lon, q.lat]).addTo(this.map);
      }
      this.probeMarkers[i].setLngLat([q.lon, q.lat]);
      this.probeMarkers[i].getElement().textContent =
        `${this.show_names ? `${name} ` : ''}${fmtTW(q.t, 'md')}${q.kind === 'fcst' ? '（預報）' : ''}`;
    });
  }

  /** 路徑動畫:各颱風從目前位置走到最後的預報點(帶暴風圈;不畫 70% 潛勢圓),速度固定(animSpeed 小時 / 秒);
   *  起點停 animHold → 移動 → 終點停 animHold → 回起點重來。每個颱風各自循環,路徑短的不用等路徑長的 */
  animate(on) {
    cancelAnimationFrame(this.raf);
    const was = !!this.raf;
    this.raf = 0;
    if (!on || !this.visible || !this.tracks.length) {
      if (was) { this.setProbe([]); this.onAnim?.(false); }
      return false;
    }
    this.popup?.remove();
    const start = performance.now();
    const step = (now) => {
      const tr = this.tracks.filter((k) => k.pts[k.pts.length - 1].ms > k.nowMs);   // 有預報的才動
      if (!tr.length) { this.animate(false); return; }
      const hold = this.animHold, elapsed = now - start;
      this.setProbe(tr.map((k) => {
        const span = k.pts[k.pts.length - 1].ms - k.nowMs;
        const move = (span / 36e5 / this.animSpeed) * 1000;           // 這個颱風走完要幾毫秒
        const e = elapsed % (hold + move + hold);
        const f = e < hold ? 0 : Math.min(1, (e - hold) / move);
        return { name: k.name, q: at(k, k.nowMs + f * span) };
      }), true, false);                                                // 動畫不畫 70% 潛勢圓
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
    this.onAnim?.(true);
    return true;
  }

  /** 指定初始時間優先;同步取 ≤ T 的最近一次;不同步取最新 */
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
    if (data !== this.data && !this.raf) this.popup?.remove();   // 換了一次預報,點選的位置已不適用
    this.data = data;
    this.draw();
  }

  draw() {
    const storms = this.data?.storms ?? [];
    const cone = [], c15 = [], c25 = [], past = [], fcst = [];
    this.markers.forEach((mk) => mk.remove());
    this.markers = [];
    this.tracks = [];

    for (const s of storms) {
      const name = s.name_zh ? `${s.name_zh} ${s.name_en ?? ''}`.trim() : (s.name_en ?? s.id);
      if (s.geo.cone70) cone.push({ type: 'Feature', geometry: s.geo.cone70, properties: {} });

      const pts = s.past;
      if (pts.length > 1) past.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: pts.map((p) => [p.lon, p.lat]) }, properties: {} });
      pts.forEach((p, i) => past.push({
        type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
        properties: { name, now: i === pts.length - 1, color: category(p.wind, p.state).color, json: JSON.stringify(p) },
      }));

      const now = pts[pts.length - 1];
      const fp = s.fcst.map((p) => ({ ...p, t: addMin(s.fcst_init, p.tau * 60) }));
      if (now && fp.length) {
        fcst.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[now.lon, now.lat], ...fp.map((p) => [p.lon, p.lat])] }, properties: {} });
      }
      // 暴風圈:過去各定位(有四象限就用四象限)、目前位置、各預報點
      const addCircles = (p, kind) => {
        const [r15, r25] = this.radii(p);
        if (r15) c15.push({ type: 'Feature', geometry: windCircle(p.lon, p.lat, r15), properties: { kind } });
        if (r25) c25.push({ type: 'Feature', geometry: windCircle(p.lon, p.lat, r25), properties: { kind } });
      };
      if (this.circles.past) pts.slice(0, -1).forEach((p) => addCircles(p, 'past'));
      if (this.circles.now && now) addCircles(now, 'now');
      if (this.circles.fcst) fp.forEach((p) => addCircles(p, 'fcst'));

      const ms = (p) => toDate(p.t).getTime();
      // 目前位置的 70% 機率半徑當 0,動畫從這裡開始由 0 漸漸擴大到各預報點的半徑
      const track = [...pts.map((p) => ({ ...p, kind: 'past', ms: ms(p), ...(p === now ? { r70: 0 } : {}) })),
        ...fp.map((p) => ({ ...p, kind: 'fcst', init: s.fcst_init, ms: ms(p) }))];
      if (track.length) this.tracks.push({ name, pts: track, nowMs: now ? ms(now) : track[0].ms });

      fp.forEach((p) => fcst.push({
        type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
        properties: { name, color: category(p.wind, p.state).color, json: JSON.stringify(p) },
      }));

      if (!this.visible) continue;
      if (now && this.show_names) this.addMarker([now.lon, now.lat], 'ty-name', name);
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
      'ty-past-line', 'ty-fcst-line', 'ty-past-hit', 'ty-fcst-hit', 'ty-past-pt', 'ty-fcst-pt',
      'ty-probe-c70-fill', 'ty-probe-c70-line', 'ty-probe-fill', 'ty-probe-line', 'ty-probe-pt']) {
      this.map.setLayoutProperty(id, 'visibility', v ? 'visible' : 'none');
    }
    if (!v) { this.animate(false); this.popup?.remove(); this.setProbe([]); }
    this.draw();
  }

  storms() { return this.data?.storms ?? []; }

  /** 圖例:路徑線、潛勢區、暴風圈、強度分級(色階框是深色底,線條用深色底圖的顏色) */
  legend() {
    const th = THEME.dark;
    const item = (svg, text) => `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:12px;white-space:nowrap">
      <svg width="30" height="14" viewBox="0 0 30 14">${svg}</svg>${text}</span>`;
    const dot = (c) => `<circle cx="15" cy="7" r="4.5" fill="${c}" stroke="#000" stroke-width="0.8"/>`;
    const ring = (c) => `<circle cx="15" cy="7" r="6" fill="${c}" fill-opacity="0.25" stroke="${c}" stroke-width="1.5"/>`;
    const lines = [
      item(`<line x1="1" y1="7" x2="29" y2="7" stroke="${th.track}" stroke-width="2"/><circle cx="15" cy="7" r="3" fill="#fb8c00" stroke="#000" stroke-width="0.6"/>`, '過去路徑'),
      item(`<line x1="1" y1="7" x2="29" y2="7" stroke="${th.fcst}" stroke-width="2" stroke-dasharray="4 3"/>`, '預報路徑'),
      this.show_cone ? item(`<rect x="2" y="2" width="26" height="10" rx="5" fill="${th.cone}" fill-opacity="0.15" stroke="${th.cone}" stroke-width="1" stroke-dasharray="3 2"/>`, '70% 潛勢區') : '',
      item(ring('#f9a825'), '7 級風暴風圈'),
      item(ring('#e53935'), '10 級風暴風圈'),
    ].join('');
    const cats = [[10], [20], [40], [55], [null, 'ext'], [null, 'low']].map(([w, s]) => category(w, s))
      .map((c) => item(dot(c.color), c.name)).join('');
    return `<div class="legend-title">颱風路徑（氣象署）</div>
      <div style="display:flex;flex-wrap:wrap;row-gap:3px;font-size:12px;max-width:460px">${lines}</div>
      <div style="display:flex;flex-wrap:wrap;row-gap:3px;font-size:12px;margin-top:3px;max-width:460px">${cats}</div>`;
  }

  setTheme(theme) {
    this.theme = theme;
    const th = THEME[theme], m = this.map;
    m.setPaintProperty('ty-cone-fill', 'fill-color', th.cone);
    m.setPaintProperty('ty-cone-fill', 'fill-opacity', th.coneOp);
    m.setPaintProperty('ty-cone-line', 'line-color', th.cone);
    m.setPaintProperty('ty-probe-c70-fill', 'fill-color', th.cone);
    m.setPaintProperty('ty-probe-c70-fill', 'fill-opacity', th.coneOp * 2);
    m.setPaintProperty('ty-probe-c70-line', 'line-color', th.cone);
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

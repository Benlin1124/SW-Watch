// SW-Watch 主程式:地圖、圖層面板、時間軸(同步 / 不同步、對齊播放)
import { REFRESH_SEC, STEP_MIN, TIMELINE_DAYS } from './config.js';
import { addMin, diffMin, floorStep, fmtTW, fmtUTC, nowStamp } from './time.js';
import { RadarLayer } from './layers/radar.js';
import { SatelliteLayer } from './layers/satellite.js';
import { EcmwfLayer, fmtEcInit } from './layers/ecmwf.js';
import { WindLayer } from './layers/wind.js';
import { category, lonFix, TyphoonLayer } from './layers/typhoon.js';
import { STATION_TYPES, STATION_VARS, StationLayer } from './layers/stations.js';
import { MARINE_VARS, MarineCard, MarineLayer } from './layers/marine.js';
import { localToStamp, stampToLocal, twMidnight } from './layers/station_custom.js';
import { StationCard } from './station_card.js';
import { defaultCfg, EnsembleLayer, fmtInit, MODEL_COLORS, MODEL_NAMES } from './layers/ensemble.js';
import { getJSON } from './data.js';
import * as prefs from './prefs.js';
import { Capture } from './capture.js';

const $ = (id) => document.getElementById(id);

// ── 底圖:素色向量(Natural Earth 10m + NCDR 縣市界,仿 notebook 的 cartopy 底圖)──
// 產生方式見 pipeline/build_basemap.py;另保留 Esri 衛星影像
const BASE = new URL('../assets/basemap/', import.meta.url).href;
// casing = 線條外圍的襯邊(和線條反差的顏色),疊在雷達、雲圖上也看得清楚
const THEMES = {
  light: { bg: '#ffffff', land: '#f5f5f5', coast: '#000000', border: '#222222', county: '#1a1a1a', km100: '#1565c0', casing: 'rgba(255,255,255,0.85)', grid: 'rgba(0,0,0,0.18)', imagery: false },
  dark: { bg: '#1b1f26', land: '#2e333c', coast: '#d5dbe3', border: '#f2f5f8', county: '#ffffff', km100: '#64b5f6', casing: 'rgba(0,0,0,0.6)', grid: 'rgba(255,255,255,0.12)', imagery: false },
  imagery: { bg: '#000000', land: '#000000', coast: '#ffffff', border: '#ffffff', county: '#ffffff', km100: '#90caf9', casing: 'rgba(0,0,0,0.65)', grid: 'rgba(255,255,255,0.25)', imagery: true },
};
// 線寬隨縮放加粗(全區看得到,放大不會太細)
const LINE_W = { coast: [1, 1.6, 2.6], borders: [1.3, 2, 3], county: [0.8, 1.4, 2.4], km100: [1, 1.5, 2.2] };   // 縮放 4、7、11
const zw = ([a, b, c], plus = 0) => ['interpolate', ['linear'], ['zoom'], 4, a + plus, 7, b + plus, 11, c + plus];

/** 經緯網格:每 5° 一條(全部縮放),放大後加 1° 細線 */
function graticule() {
  const f = [];
  for (let lon = 90; lon <= 180; lon += 1) {
    f.push({ type: 'Feature', properties: { major: lon % 5 === 0 }, geometry: { type: 'LineString', coordinates: [[lon, -15], [lon, 60]] } });
  }
  for (let lat = -15; lat <= 60; lat += 1) {
    f.push({ type: 'Feature', properties: { major: lat % 5 === 0 }, geometry: { type: 'LineString', coordinates: [[90, lat], [180, lat]] } });
  }
  return { type: 'FeatureCollection', features: f };
}

const th0 = THEMES.light;
const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    sources: {
      land: { type: 'geojson', data: `${BASE}land.json`, attribution: 'Natural Earth' },
      imagery: { type: 'raster', tileSize: 256, maxzoom: 18, attribution: 'Imagery © Esri',
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'] },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': th0.bg } },
      { id: 'imagery', type: 'raster', source: 'imagery', layout: { visibility: 'none' } },
      { id: 'land', type: 'fill', source: 'land', paint: { 'fill-color': th0.land } },
    ],
  },
  center: prefs.get('view')?.center ?? [121, 23.7],
  zoom: prefs.get('view')?.zoom ?? 6.2,
  attributionControl: { compact: true, customAttribution: '資料：中央氣象署、NCDR、ECMWF (CC BY 4.0)、NOAA NCEP、Google DeepMind WeatherLab' },
});

/** 海岸線、國界、縣市界、經緯網格疊在雷達上面(同 notebook:先畫資料再畫邊界) */
function addOverlays(beforeId) {
  const th = THEMES.light;
  map.addSource('coast', { type: 'geojson', data: `${BASE}coast.json` });
  map.addSource('borders', { type: 'geojson', data: `${BASE}borders.json` });
  map.addSource('county', { type: 'geojson', data: `${BASE}taiwan.json` });
  map.addSource('km100', { type: 'geojson', data: `${BASE}km100.json` });   // NCDR 台灣周圍 100 公里線
  map.addSource('grid', { type: 'geojson', data: graticule() });
  map.addLayer({ id: 'grid-minor', type: 'line', source: 'grid', minzoom: 5.5, filter: ['!', ['get', 'major']],
    paint: { 'line-color': th.grid, 'line-width': 0.5 } }, beforeId);
  map.addLayer({ id: 'grid-major', type: 'line', source: 'grid', filter: ['get', 'major'],
    paint: { 'line-color': th.grid, 'line-width': 0.8 } }, beforeId);
  for (const id of ['coast', 'borders', 'county', 'km100']) {
    const layout = { 'line-join': 'round', 'line-cap': 'round' };
    map.addLayer({ id: `${id}-casing`, type: 'line', source: id, layout,
      paint: { 'line-color': th.casing, 'line-width': zw(LINE_W[id], 2), 'line-blur': 0.5 } }, beforeId);
    map.addLayer({ id, type: 'line', source: id, layout, paint: { 'line-color': th[id === 'borders' ? 'border' : id], 'line-width': zw(LINE_W[id]) } }, beforeId);
  }
  map.setPaintProperty('borders', 'line-dasharray', [3, 1.5]);   // 國界虛線,和海岸線分得開
  map.setPaintProperty('km100', 'line-dasharray', [4, 2]);
}

function setTheme(name) {
  const th = THEMES[name];
  map.setPaintProperty('bg', 'background-color', th.bg);
  map.setPaintProperty('land', 'fill-color', th.land);
  map.setLayoutProperty('land', 'visibility', th.imagery ? 'none' : 'visible');
  map.setLayoutProperty('imagery', 'visibility', th.imagery ? 'visible' : 'none');
  map.setPaintProperty('coast', 'line-color', th.coast);
  map.setPaintProperty('borders', 'line-color', th.border);
  map.setPaintProperty('county', 'line-color', th.county);
  map.setPaintProperty('km100', 'line-color', th.km100);
  for (const id of ['coast', 'borders', 'county', 'km100']) map.setPaintProperty(`${id}-casing`, 'line-color', th.casing);
  map.setPaintProperty('grid-major', 'line-color', th.grid);
  map.setPaintProperty('grid-minor', 'line-color', th.grid);
  typhoon.setTheme(name === 'light' ? 'light' : 'dark');
}

map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

window.swMap = map;     // 除錯 / 之後截圖功能用
const radar = new RadarLayer(map);
const satellite = new SatelliteLayer(map);
const ecmwf = new EcmwfLayer(map);
const wind = new WindLayer(map, ecmwf);
const waves = new WindLayer(map, ecmwf, 'wave');
const typhoon = new TyphoonLayer(map);
const ens = new EnsembleLayer(map);
// 系集各模式的設定(初始時間不存:下次打開已過時)
for (const [m, c] of Object.entries(prefs.get('ensCfg') ?? {})) ens.cfg[m] = { ...defaultCfg(), ...c, init: '' };
const stations = new StationLayer(map);
const card = new StationCard(stations);
stations.onSelect = (id) => openStation(id, false);
const marine = new MarineLayer(map);
const mCard = new MarineCard(marine);
marine.onSelect = (id) => { card.close(); mCard.open(id, state.T); };
const LAYERS = [satellite, ecmwf, radar, stations, marine, typhoon, ens];
// 衛星這一張還沒好:畫面維持上一張,時間欄先標要顯示的時間「載入中」(好了由 updateLayerTime 蓋掉)
satellite.onLoading = (stamp) => {
  if (!stamp) return;
  const el = $('time-satellite');
  el.textContent = `${fmtTW(stamp)} 載入中…`;
  el.classList.add('stale');
};

// ── 狀態 ──
const state = {
  sync: true,        // 同步:所有圖層對齊 T;不同步:各自最新
  T: null,           // 目前時間(UTC stamp)
  follow: true,      // T 停在最新時,有新資料自動往前
  slots: [],         // 時間軸每一格
  playing: false,
  playTimer: null,
  frames: [],
  renderSeq: 0,
};

function enabled() { return LAYERS.filter((l) => l.visible && l.index); }

/** 時間軸範圍 = 「範圍」選單的長度(也是播放範圍),結尾為最新資料;每 10 分一格 */
/** 同步基準:開著的雷達、衛星都有資料的時間點(只開一個就用它的;都沒開或交集為空 → 不限制) */
function commonTimes() {
  const ls = [radar, satellite].filter((l) => l.visible && l.index);
  if (!ls.length) return null;
  const sets = ls.slice(1).map((l) => new Set(l.times));
  const common = ls[0].times.filter((t) => sets.every((x) => x.has(t)));
  return common.length ? new Set(common) : null;
}

const ok = (t) => !state.common || state.common.has(t);

/** 最後一個雷達、雲圖都有的格 */
function latestSlot() {
  for (let i = state.slots.length - 1; i >= 0; i--) if (ok(state.slots[i])) return state.slots[i];
  return state.slots[state.slots.length - 1] ?? null;
}

function buildSlots() {
  state.common = commonTimes();
  const all = LAYERS.flatMap((l) => l.times);
  if (!all.length) { state.slots = []; return; }
  // 結尾 = 雷達、雲圖都有的最新時間(衛星約晚 20 分上架,不讓時間軸停在只有雷達的格)
  const end = floorStep(state.common ? [...state.common].reduce((a, b) => (a > b ? a : b)) : all.reduce((a, b) => (a > b ? a : b)));
  const earliest = floorStep(all.reduce((a, b) => (a < b ? a : b)));
  const limit = addMin(end, -Math.min(+$('play-range').value * 60, TIMELINE_DAYS * 1440) + STEP_MIN);
  let t = earliest > limit ? earliest : limit;
  const slots = [];
  while (t <= end) { slots.push(t); t = addMin(t, STEP_MIN); }
  state.slots = slots;
}

// ── 畫面更新 ──
async function render() {
  const sync = state.sync || state.playing;
  updateClock();
  const seq = ++state.renderSeq;
  await Promise.all(LAYERS.map(async (l) => {
    if (!l.index) return;
    const stamp = l.pick(state.T, sync);
    try { await l.show(stamp); } catch (e) { console.warn(l.key, stamp, e); await l.show(null); }
    if (seq === state.renderSeq) updateLayerTime(l, stamp, sync);   // 較慢的舊畫面不覆蓋新的時間標示
  }));
  await updateWind();
  if (!state.playing) { renderStorms(); refreshStationUI(); }
  if (ecmwf.visible || wind.visible || waves.visible) updateLegend();        // ECMWF 圖例跟著變數、時刻、雨量時段
  card.update(state.T);
  mCard.update(state.T);
}

/** 風場 / 海浪動畫跟著 ECMWF 顯示的時刻或時間軸(不同步時用現在) */
async function updateWind() {
  const T = state.sync || state.playing ? state.T : null;
  await Promise.all([wind, waves].filter((l) => l.visible).map(async (l) => {
    try { await l.update(T); } catch (e) { console.warn(l.key, e); }
    const el = $(`time-${l.key}`), t = l.timeLabel();
    el.textContent = t ? t.text : '無資料';
    el.classList.toggle('nodata', !t);
  }));
}

function updateLayerTime(l, stamp, sync) {
  const el = $(`time-${l.key}`);
  el.classList.remove('nodata', 'stale');
  if (!stamp && !l.visible) { el.textContent = '--'; return; }      // 沒勾的圖層不顯示「無資料」
  if (!stamp) { el.textContent = '無資料'; el.classList.add('nodata'); return; }
  if (l.key === 'typhoon') {
    el.textContent = `初始 ${fmtTW(stamp)}`;
    return;
  }
  if (l.key === 'ens') {
    const inits = [...new Set(Object.values(ens.resolved))];
    el.textContent = inits.length === 1 ? `初始 ${fmtInit(inits[0])}` : inits.length ? '各模式不同' : '無資料';
    if (!inits.length) el.classList.add('nodata');
    syncEnsSelects();
    return;
  }
  if (l.key === 'ecmwf') syncEcmwfUI();
  const custom = l.timeLabel?.(stamp);
  if (custom) {
    el.textContent = custom.text;
    if (custom.stale) el.classList.add('stale');
    return;
  }
  const age = Math.round(diffMin(nowStamp(), stamp));
  el.textContent = fmtTW(stamp);
  if (!sync && age > (l.staleMin ?? 20)) { el.textContent += `（${age} 分前）`; el.classList.add('stale'); }
}

function updateClock() {
  if (state.sync || state.playing) {
    $('clock-main').textContent = state.T ? `${fmtTW(state.T, 'full')}（台灣）` : '--';
    $('clock-utc').textContent = state.T ? fmtUTC(state.T) : '';
  } else {
    $('clock-main').textContent = '各圖層最新資料';
    $('clock-utc').textContent = '時間見左側各圖層';
  }
  const i = state.slots.indexOf(state.T);
  if (i >= 0) $('slider').value = i;
}

function renderStorms() {
  const box = $('ty-storms');
  box.innerHTML = '';
  for (const s of typhoon.storms()) {
    const now = s.past[s.past.length - 1];
    const div = document.createElement('div');
    div.className = 'storm-item';
    div.innerHTML = `<div>${s.name_zh ?? ''} ${s.name_en ?? ''}<br><small>${category(now?.wind).name}　${now?.pres ?? '—'} hPa</small></div>`;
    const btn = document.createElement('button');
    btn.textContent = '定位';
    btn.onclick = () => typhoon.fitStorm(s.id);
    div.appendChild(btn);
    box.appendChild(div);
  }
  if (!typhoon.storms().length) box.innerHTML = '<small>目前沒有颱風</small>';
}

// ── 時間軸 ──
function refreshSlider() {
  const s = $('slider');
  s.max = Math.max(state.slots.length - 1, 0);
  drawCoverage();
  drawTicks();
}

/** 每個圖層一條色帶,有資料的格上色,缺漏處留空 */
function drawCoverage() {
  const cv = $('coverage');
  const w = cv.clientWidth, h = cv.clientHeight;
  cv.width = w * devicePixelRatio; cv.height = h * devicePixelRatio;
  const ctx = cv.getContext('2d');
  ctx.scale(devicePixelRatio, devicePixelRatio);
  ctx.clearRect(0, 0, w, h);
  const n = state.slots.length;
  if (!n) return;
  const rows = [[{ times: [...(state.common ?? [])], cadence: 10 }, '#ffffff'], [satellite, '#b0bec5'], [radar, '#4fc3f7'], [stations, '#81c784'], [marine, '#4dd0e1'], [typhoon, '#ffd54f'], [ens, '#ef5350']];
  const rh = h / rows.length;
  const x = (i) => (n === 1 ? w / 2 : (i / (n - 1)) * w);
  rows.forEach(([l, color], r) => {
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(0, r * rh + 1, w, rh - 2);
    ctx.fillStyle = color;
    const set = new Set(l.times);
    const bw = Math.max(w / n, 1);
    state.slots.forEach((t, i) => {
      if (set.has(t) || (l.cadence == null && l.times.some((s) => floorStep(s) === t))) ctx.fillRect(x(i) - bw / 2, r * rh + 1, bw, rh - 2);
    });
  });
}

function drawTicks() {
  const box = $('slider-ticks');
  box.innerHTML = '';
  const n = state.slots.length;
  if (n < 2) return;
  const hours = (n * STEP_MIN) / 60;
  const every = hours <= 1.5 ? 10 : hours <= 3 ? 30 : hours <= 6 ? 60 : hours <= 24 ? 180 : hours <= 72 ? 720 : 1440; // 分鐘
  state.slots.forEach((t, i) => {
    const twMin = (+t.slice(8, 10) * 60 + +t.slice(10, 12) + 480) % 1440;
    if (twMin % every !== 0) return;
    const span = document.createElement('span');
    span.style.left = `${(i / (n - 1)) * 100}%`;
    span.textContent = every >= 1440 ? fmtTW(t).slice(0, 5) : fmtTW(t, 'hm');
    box.appendChild(span);
  });
}

function setSync(on) {
  state.sync = on;
  $('btn-sync').classList.toggle('on', on);
  $('btn-sync').textContent = on ? '🔗 同步' : '⛓️‍💥 不同步';
}

/** 跳到第 i 格;該格雷達、雲圖不齊時,dir = ±1 往該方向找,0 找最近的 */
function goto(i, dir = 0) {
  const n = state.slots.length;
  if (!n) return;
  i = Math.max(0, Math.min(n - 1, i));
  if (!ok(state.slots[i])) {
    let found = -1;
    for (let d = 1; d < n && found < 0; d++) {
      for (const j of dir ? [i + dir * d] : [i - d, i + d]) {
        if (j >= 0 && j < n && ok(state.slots[j])) { found = j; break; }
      }
    }
    if (found < 0) { updateClock(); return; }   // 這個方向已經沒有了
    i = found;
  }
  state.T = state.slots[i];
  state.follow = state.T === latestSlot();
  if (!state.sync) setSync(true);   // 拖動時間軸 = 指定時間 → 自動切到同步
  render();
}

// ── 播放(永遠對齊)──
async function play() {
  if (state.playing) return stop();
  // 結尾 = 開啟中、固定週期圖層都有資料的最新時間
  const ends = enabled().filter((l) => l.cadence).map((l) => l.latest).filter(Boolean);
  const end = ends.length ? ends.reduce((a, b) => (a < b ? a : b)) : state.slots[state.slots.length - 1];
  const frames = state.slots.filter((t) => t <= end && ok(t));      // 時間軸本身就是播放範圍;只播雷達、雲圖都有的格
  if (!frames.length) return;
  state.wasSync = state.sync;
  state.playing = true;
  $('btn-play').textContent = '⏸';
  for (const l of enabled().filter((x) => x.prefetch)) {
    if (!state.playing) break;
    await l.prefetch(frames.filter((t) => l.times.includes(t)),
      (d, n) => toast(`載入${l.name} ${d}/${n}`, d === n ? 600 : 0));
  }
  if (!state.playing) return;
  state.frames = frames;
  let k = 0;
  const step = async () => {
    if (!state.playing) return;
    state.T = frames[k];
    await render();
    k = (k + 1) % frames.length;
    state.playTimer = setTimeout(step, k === 0 ? +$('play-speed').value * 3 : +$('play-speed').value);
  };
  step();
}

function stop() {
  state.playing = false;
  clearTimeout(state.playTimer);
  $('btn-play').textContent = '▶';
  setSync(state.wasSync ?? state.sync);
  if (!state.sync) state.T = latestSlot();
  render();
}

function toast(msg, hideAfter = 0) {
  const el = $('toast');
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(el._t);
  if (hideAfter) el._t = setTimeout(() => { el.style.display = 'none'; }, hideAfter);
}

// ── 資料更新 ──
async function reload() {
  await Promise.all(LAYERS.map((l) => l.load().catch((e) => console.warn(`${l.key} 尚無資料`, e))));
  const wasEnd = state.follow;
  buildSlots();
  refreshSlider();
  fillIssueSelect();
  fillEnsPanel();
  fillEcmwfPanel();
  await loadBestTrack();
  if (!state.T || wasEnd || !state.slots.includes(state.T) || !ok(state.T)) state.T = latestSlot();
}

function fillIssueSelect() {
  const sel = $('ty-issue');
  const cur = sel.value;
  sel.innerHTML = '<option value="">依時間軸</option>' +
    [...typhoon.times].reverse().map((t) => `<option value="${t}">${fmtTW(t)}（${t.slice(8, 10)}Z）</option>`).join('');
  sel.value = typhoon.times.includes(cur) ? cur : '';
}

// ── 系集面板 ──
// 下拉選單只顯示時間(10/22 00Z);沒手動選時,選單停在實際用到的時間(依時間軸)
const optInit = (i) => `<option value="${i}">${fmtInit(i)}</option>`;
const optValid = (t) => `<option value="${t}">${t.slice(4, 6)}/${t.slice(6, 8)} ${t.slice(8, 10)}Z</option>`;

function fillEnsPanel() {
  if (!ens.index) return;
  const tcSel = $('ens-tc');
  tcSel.innerHTML = Object.entries(ens.index.tcs ?? {}).map(([id, t]) => `<option value="${id}">${t.name_zh ?? ''} ${t.name_en ?? id}</option>`).join('');
  tcSel.value = ens.tc;

  const allInits = [...new Set(Object.values(ens.index.models).flat())].sort().reverse();
  const initSel = $('ens-init');
  initSel.innerHTML = allInits.map(optInit).join('');

  buildModelRows();

  const vs = $('ens-valid-start');
  vs.innerHTML = ens.validChoices().map(optValid).join('');
  syncEnsSelects();
}

/** 每個模式一列(可展開):開關、初始時間、成員 / 平均 / 控制報、tau 範圍、透明度;最上面「全部模式」一次套用 */
function buildModelRows() {
  const box = $('ens-models');
  box.innerHTML = '';
  const tauMode = ens.mode === 'tau';
  const body = (c) => `
    <div class="row">
      <label><input type="checkbox" data-k="members" ${c.members ? 'checked' : ''}> 成員</label>
      <label><input type="checkbox" data-k="mean" ${c.mean ? 'checked' : ''}> 平均</label>
      <label><input type="checkbox" data-k="control" ${c.control ? 'checked' : ''}> 控制報</label>
    </div>
    <div class="row" ${tauMode ? '' : 'hidden'}>tau
      <input type="number" data-k="tau0" min="0" max="360" step="6" value="${c.tau[0]}"> ～
      <input type="number" data-k="tau1" min="0" max="360" step="6" value="${c.tau[1]}"> 小時
    </div>
    <div class="row">透明度 <input type="range" data-k="opacity" min="0" max="100" value="${Math.round(c.opacity * 100)}"></div>`;

  const bindBody = (el, targets, isAll) => {
    for (const inp of el.querySelectorAll('[data-k]')) {
      const k = inp.dataset.k;
      inp.addEventListener(k === 'opacity' ? 'input' : 'change', () => {
        for (const m of targets) {
          const c = ens.cfg[m];
          if (k === 'opacity') c.opacity = inp.value / 100;
          else if (k === 'tau0' || k === 'tau1') {
            const row = inp.closest('.row');
            let a = +row.querySelector('[data-k=tau0]').value, b = +row.querySelector('[data-k=tau1]').value;
            if (a > b) [a, b] = [b, a];
            c.tau = [a, b];
          } else c[k] = inp.checked;
        }
        ens.draw();
        if (isAll) syncRowsFromCfg();          // 全部套用後,各模式列同步顯示
      });
    }
  };

  // 全部模式
  const all = document.createElement('div');
  all.className = 'model all';
  const first = ens.cfg[ens.models[0]] ?? { members: true, mean: true, control: true, tau: [0, 120], opacity: 0.8 };
  all.innerHTML = `<div class="model-head"><label><b>全部模式</b></label><button class="expand">▸</button></div>
    <div class="model-body" hidden>${body(first)}</div>`;
  box.appendChild(all);
  bindBody(all, ens.models, true);

  for (const m of ens.models) {
    const c = ens.cfg[m];
    const row = document.createElement('div');
    row.className = 'model';
    row.dataset.model = m;
    row.innerHTML = `<div class="model-head">
        <label title="${MODEL_NAMES[m] ?? m}"><input type="checkbox" data-on ${c.on ? 'checked' : ''}>
          <span class="swatch" style="background:${MODEL_COLORS[m] ?? '#888'}"></span>${m}</label>
        <select>${[...ens.index.models[m]].reverse().map(optInit).join('')}</select>
        <button class="expand">▸</button>
      </div>
      <div class="model-body" hidden>${body(c)}</div>`;
    const sel = row.querySelector('select');
    row.querySelector('[data-on]').onchange = (e) => { c.on = e.target.checked; render(); };
    sel.onchange = () => { c.init = sel.value; render(); };
    bindBody(row, [m], false);
    box.appendChild(row);
  }
  pairNumbers(box);
  for (const btn of box.querySelectorAll('.expand')) {
    btn.onclick = () => {
      const b = btn.closest('.model').querySelector('.model-body');
      b.hidden = !b.hidden;
      btn.textContent = b.hidden ? '▸' : '▾';
    };
  }
}

/** 拉桿旁加一個數字輸入框,兩邊同步(輸入數字 = 拉到該位置) */
function pairNumbers(root = document) {
  for (const range of root.querySelectorAll('#panel input[type=range]')) {
    if (range.nextElementSibling?.classList.contains('num')) continue;
    const n = document.createElement('input');
    Object.assign(n, { type: 'number', className: 'num', min: range.min, max: range.max, step: range.step || 1, value: range.value });
    range.after(n);
    range.addEventListener('input', () => { n.value = range.value; });
    n.addEventListener('input', () => {
      if (n.value === '') return;
      range.value = Math.max(+range.min, Math.min(+range.max, +n.value));
      range.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
}

/** 「全部模式」改了設定後,把各模式列的勾選、tau、透明度更新成目前值 */
function syncRowsFromCfg() {
  for (const row of document.querySelectorAll('#ens-models .model[data-model]')) {
    const c = ens.cfg[row.dataset.model];
    for (const inp of row.querySelectorAll('[data-k]')) {
      const k = inp.dataset.k;
      if (k === 'opacity') {
        inp.value = Math.round(c.opacity * 100);
        if (inp.nextElementSibling?.classList.contains('num')) inp.nextElementSibling.value = inp.value;
      }
      else if (k === 'tau0') inp.value = c.tau[0];
      else if (k === 'tau1') inp.value = c.tau[1];
      else inp.checked = c[k];
    }
  }
}

/** 系集下拉選單停在實際用到的時間:手動選過的用選的,沒選過的用依時間軸算出來的 */
function syncEnsSelects() {
  const inits = Object.values(ens.resolved);
  $('ens-init').value = ens.baseInit || (inits.length ? inits.reduce((a, b) => (a > b ? a : b)) : '');
  for (const row of document.querySelectorAll('#ens-models .model[data-model]')) {
    const m = row.dataset.model, sel = row.querySelector('select');
    if (sel) sel.value = ens.cfg[m].init || ens.resolved[m] || '';
  }
  $('ens-valid-start').value = ens.validStart || ens.windowStart() || '';
}

/** 實際路徑:最新一次氣象署颱風資料裡的過去定位 */
async function loadBestTrack() {
  if (!typhoon.latest) return;
  try {
    const d = lonFix(await getJSON(`typhoon/cwa_track/${typhoon.latest}.json`));
    const s = d.storms.find((x) => x.id === ens.tc);
    ens.setBestTrack(s ? s.past : null);
  } catch (e) { console.warn('best track', e); }
}

function bindEnsUI() {
  $('chk-ens').onchange = (e) => ens.setVisible(e.target.checked);
  $('ens-tc').onchange = async (e) => { ens.tc = e.target.value; await loadBestTrack(); ens.draw(); };
  $('ens-init').onchange = (e) => { ens.baseInit = e.target.value; render(); };
  for (const r of document.querySelectorAll('input[name=ens-mode]')) {
    r.onchange = () => {
      ens.mode = r.value;
      $('ens-valid-box').hidden = ens.mode !== 'valid';
      for (const r of document.querySelectorAll('#ens-models [data-k=tau0]')) r.closest('.row').hidden = ens.mode !== 'tau';
      ens.draw();
      syncEnsSelects();
    };
  }
  $('ens-valid-start').onchange = (e) => { ens.validStart = e.target.value; ens.draw(); syncEnsSelects(); };
  $('ens-valid-hours').onchange = (e) => { ens.validHours = +e.target.value; ens.draw(); };
  for (const c of document.querySelectorAll('[data-ens-opt]')) {
    c.onchange = () => { ens.opts[c.dataset.ensOpt] = c.checked; ens.draw(); };
  }
}

// ── 測站面板 ──
function updateLegend() {
  const parts = [satellite, ecmwf, wind, waves, radar, stations, marine, typhoon].filter((l) => l.visible && l.index).map((l) => `<div class="legend-block">${l.legend()}</div>`);
  $('legend-body').innerHTML = parts.join('');
  $('legend').style.display = parts.length ? '' : 'none';
}

// 色階大小:0.6–2 倍,每次 ±0.1;可收合成只剩標題列
function bindLegendScale() {
  const fold = (on) => {
    $('legend').classList.toggle('folded', on);
    $('legend-fold').textContent = on ? '▸' : '▾';
    $('legend-fold').title = on ? '展開色階' : '收合色階';
    prefs.set('legendFolded', on);
  };
  fold(!!prefs.get('legendFolded'));
  $('legend-fold').onclick = () => fold(!$('legend').classList.contains('folded'));
  const apply = (z) => {
    z = Math.min(2, Math.max(0.6, Math.round(z * 10) / 10));
    $('legend-body').style.zoom = z;
    prefs.set('legendScale', z);
    return z;
  };
  let z = apply(prefs.get('legendScale') ?? 1);
  $('legend-minus').onclick = () => { z = apply(z - 0.1); };
  $('legend-plus').onclick = () => { z = apply(z + 0.1); };
}

function bindStationUI() {
  const vSel = $('st-var');
  vSel.innerHTML = Object.entries(STATION_VARS).map(([k, v]) => `<option value="${k}">${v.name}${v.agg || v.rain ? '' : '（僅當前值）'}</option>`).join('');
  vSel.value = stations.variable;
  const custom = prefs.get('stCustom') ?? {};
  $('st-cstart').value = stampToLocal(custom.start ?? '');
  $('st-cend').value = stampToLocal(custom.end ?? '');
  const apply = async () => {
    const v = STATION_VARS[vSel.value];
    const statSel = $('st-stat'), hSel = $('st-hours');
    // 過去最大 / 最小:有預先統計的變數;區段累積:雨量
    for (const o of statSel.options) o.disabled = o.value === 'sum' ? !v.rain : o.value !== 'now' && !v.agg;
    if (statSel.selectedOptions[0].disabled) statSel.value = 'now';
    const sum = statSel.value === 'sum';
    if (sum) hSel.value = 'custom';
    $('st-rank-order').value = statSel.value === 'min' ? 'asc' : 'desc';   // 最小值排行預設低到高
    statSel.disabled = !v.agg && !v.rain;
    hSel.disabled = statSel.value === 'now' || sum;
    const isCustom = statSel.value !== 'now' && hSel.value === 'custom';
    $('st-custom').hidden = !isCustom;
    if (isCustom && !$('st-cstart').value) {   // 預設起點:最新資料那天(台灣)00:00
      $('st-cstart').value = stampToLocal(twMidnight(stations.index?.latest ?? nowStamp()));
    }
    const range = { start: localToStamp($('st-cstart').value), end: localToStamp($('st-cend').value) };
    prefs.set('stCustom', range);
    const changed = await stations.configure({ variable: vSel.value, stat: statSel.value,
      hours: hSel.value === 'custom' ? 'custom' : +hSel.value, custom: range });
    if (changed) {           // 最大 / 最小有自己的時間列表(缺漏不同)
      buildSlots();
      refreshSlider();
    }
    updateLegend();
    render();
  };
  $('st-cstart').onchange = apply;
  $('st-cend').onchange = apply;
  $('st-cend-clear').onclick = () => { $('st-cend').value = ''; apply(); };
  vSel.onchange = apply;
  $('st-stat').onchange = apply;
  $('st-hours').onchange = apply;
  $('op-stations').oninput = (e) => stations.setOpacity(e.target.value / 100);
  $('chk-stations').onchange = (e) => { stations.setVisible(e.target.checked); updateLegend(); };
}

function bindMarineUI() {
  const vSel = $('mr-var');
  const opts = (keys) => keys.map((k) => `<option value="${k}">${MARINE_VARS[k].name}</option>`).join('');
  vSel.innerHTML = `<optgroup label="海況">${opts(['wave_h', 'wave_per', 'tide', 'cur_spd', 'sst'])}</optgroup>`
    + `<optgroup label="海上氣象">${opts(['ws', 'gust', 'temp', 'pres'])}</optgroup>`;
  vSel.value = marine.variable;
  const custom = prefs.get('mrCustom') ?? {};
  $('mr-cstart').value = stampToLocal(custom.start ?? '');
  $('mr-cend').value = stampToLocal(custom.end ?? '');
  const apply = async () => {
    const types = [...document.querySelectorAll('#mr-types input:checked')].map((x) => x.value);
    const stat = $('mr-stat').value, hSel = $('mr-hours');
    hSel.disabled = stat === 'now';
    const isCustom = stat !== 'now' && hSel.value === 'custom';
    $('mr-custom').hidden = !isCustom;
    if (isCustom && !$('mr-cstart').value) {   // 預設起點:最新資料那天(台灣)00:00
      $('mr-cstart').value = stampToLocal(twMidnight(marine.index?.latest ?? nowStamp()));
    }
    const range = { start: localToStamp($('mr-cstart').value), end: localToStamp($('mr-cend').value) };
    prefs.set('mrCustom', range);
    await marine.configure({ variable: vSel.value, types, stat,
      hours: hSel.value === 'custom' ? 'custom' : +hSel.value, custom: range });
    updateLegend();
    render();
  };
  vSel.onchange = apply;
  for (const id of ['mr-stat', 'mr-hours', 'mr-cstart', 'mr-cend']) $(id).onchange = apply;
  $('mr-cend-clear').onclick = () => { $('mr-cend').value = ''; apply(); };
  for (const c of document.querySelectorAll('#mr-types input')) c.onchange = apply;
  $('op-marine').oninput = (e) => marine.setOpacity(e.target.value / 100);
  $('chk-marine').onchange = (e) => { marine.setVisible(e.target.checked); if (!e.target.checked) mCard.close(); updateLegend(); };
  marine.showLabels = $('mr-labels').checked;
  $('mr-labels').onchange = (e) => { marine.showLabels = e.target.checked; marine.drawLabels(); };
}

/** 開關雷達 / 衛星或換頻道後,同步基準時間會變 → 重建時間軸 */
function refreshTimeline() {
  if (state.playing) stop();
  buildSlots();
  refreshSlider();
  if (!state.slots.includes(state.T) || !ok(state.T) || state.follow) state.T = latestSlot();
  render();
}

function bindSatUI() {
  const apply = async () => {
    $('sat-style').hidden = $('sat-band').value !== 'B13';
    const changed = await satellite.configure({ band: $('sat-band').value, style: $('sat-style').value });
    updateLegend();
    if (changed) refreshTimeline();
    else render();
  };
  $('sat-band').onchange = apply;
  $('sat-style').onchange = apply;
  $('chk-satellite').onchange = (e) => { satellite.setVisible(e.target.checked); updateLegend(); refreshTimeline(); };
  $('op-satellite').oninput = (e) => satellite.setOpacity(e.target.value / 100);
}

// ── ECMWF 預報 ──
const ecStepLabel = (init, s) => `${fmtTW(ecmwf.validOf(init, s))}（+${s}h）`;

/** 初始時間、預報時刻選單(資料更新時重建) */
function fillEcmwfPanel() {
  if (!ecmwf.index) return;
  const iSel = $('ec-init'), init = ecmwf.activeInit;
  iSel.innerHTML = ecmwf.inits.map((i) => `<option value="${i}">${fmtEcInit(i)}</option>`).join('');
  $('ec-step').innerHTML = ecmwf.steps.map((s) => `<option value="${s}">${ecStepLabel(init, s)}</option>`).join('');
  syncEcmwfUI();
}

/** 選單停在目前顯示的起報、時刻 */
function syncEcmwfUI() {
  if (!ecmwf.index) return;
  const init = ecmwf.activeInit;
  $('ec-init').value = init;
  const sel = $('ec-step');
  if (sel.dataset.init !== init) {           // 換起報:時刻標籤跟著換
    for (const o of sel.options) o.textContent = ecStepLabel(init, +o.value);
    sel.dataset.init = init;
  }
  sel.value = ecmwf.pickedStep ?? ecmwf.step ?? ecmwf.defaultStep(init);
  $('ec-rain').hidden = ecmwf.variable !== 'rain';
}

function bindEcmwfUI() {
  const apply = () => { updateLegend(); render(); };
  $('chk-ecmwf').onchange = (e) => { ecmwf.setVisible(e.target.checked); apply(); };
  $('op-ecmwf').oninput = (e) => ecmwf.setOpacity(e.target.value / 100);
  $('ec-arrows').onchange = (e) => ecmwf.setArrows(e.target.checked);
  $('ec-var').onchange = (e) => { ecmwf.variable = e.target.value; syncEcmwfUI(); apply(); };
  $('ec-rain').onchange = (e) => { ecmwf.rainHours = +e.target.value; apply(); };
  $('ec-init').onchange = (e) => { ecmwf.init = e.target.value; apply(); };
  $('ec-step').onchange = (e) => { ecmwf.step = +e.target.value; setFollow(false); apply(); };
  const move = (d) => {
    const st = ecmwf.steps, i = st.indexOf(ecmwf.pickedStep ?? ecmwf.step) + d;
    if (i < 0 || i >= st.length) return;
    ecmwf.step = st[i];
    setFollow(false);
    apply();
  };
  $('ec-prev').onclick = () => { ecPause(); move(-1); };
  $('ec-next').onclick = () => { ecPause(); move(1); };
  const setFollow = (on) => { ecmwf.follow = on; $('ec-follow').checked = on; };
  $('ec-follow').onchange = (e) => { ecPause(); setFollow(e.target.checked); apply(); };

  // 預報播放:和下方時間軸各自獨立,只換 ECMWF 圖層的時刻;速度用時間軸的「速度」
  let timer = null, playing = false;
  const showEc = async () => {
    await ecmwf.show(ecmwf.pick(state.T));
    updateLayerTime(ecmwf, ecmwf.shown?.key, true);
    await updateWind();
    updateLegend();
  };
  const ecPause = () => {
    playing = false;
    clearTimeout(timer);
    $('ec-play').classList.remove('on');
  };
  $('ec-pause').onclick = ecPause;
  $('ec-play').onclick = async () => {
    if (playing || !ecmwf.index) return;
    if (!ecmwf.visible) { $('chk-ecmwf').checked = true; ecmwf.setVisible(true); syncLayerOff(); }
    playing = true;
    setFollow(false);
    $('ec-play').classList.add('on');
    await ecmwf.prefetch((d, n) => toast(`載入 ECMWF ${d}/${n}`, d === n ? 600 : 0));
    const st = ecmwf.steps;
    const tick = async () => {
      if (!playing) return;
      const i = st.indexOf(ecmwf.pickedStep ?? ecmwf.step);
      ecmwf.step = st[(i + 1) % st.length];
      await showEc();
      const last = ecmwf.step === st[st.length - 1];
      if (playing) timer = setTimeout(tick, +$('play-speed').value * (last ? 3 : 1));   // 最後一張多停一下
    };
    tick();
  };
  for (const id of ['ec-var', 'ec-rain', 'ec-init', 'ec-step', 'chk-ecmwf']) $(id).addEventListener('change', ecPause);
}

function bindWindUI() {
  for (const l of [wind, waves]) {
    $(`chk-${l.key}`).onchange = async (e) => { l.setVisible(e.target.checked); await updateWind(); updateLegend(); };
    $(`${l.key}-color`).onchange = (e) => { l.setColor(e.target.value); updateLegend(); };
    $(`${l.key}-density`).oninput = (e) => l.setDensity(e.target.value / 100);
  }
}

// ── 測站:搜尋、篩選、排行榜、資訊卡 ──
function openStation(id, fly = true) {
  const info = stations.all.get(id);
  if (!info) return;
  if (fly) map.flyTo({ center: [info.lon, info.lat], zoom: Math.max(map.getZoom(), 9) });
  mCard.close();
  card.open(id, state.T);
}

let stListSize = 0;
/** 搜尋清單、縣市勾選(測站清單變動時才重建)與排行榜 */
function refreshStationUI() {
  if (stations.all.size !== stListSize) {
    stListSize = stations.all.size;
    const all = [...stations.all.values()];
    $('st-list').innerHTML = all.map((s) => `<option value="${s.name}（${s.id}）">${s.county}${s.town}　${STATION_TYPES[s.type] ?? ''}</option>`).join('');
    const counties = [...new Set(all.map((s) => s.county).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-Hant'));
    const off = stations.filter.countyOff;
    $('st-counties').innerHTML = counties.map((c) => `<label><input type="checkbox" value="${c}"${off.has(c) ? '' : ' checked'}> ${c}</label>`).join('');
    for (const c of $('st-counties').querySelectorAll('input')) c.onchange = applyCounties;
    countySummary();
  }
  const box = $('st-rank');
  box.hidden = !$('st-rank-on').checked;
  if (box.hidden) return;
  const v = stations.v, list = stations.ranking(+$('st-rank-n').value, $('st-rank-order').value);
  box.innerHTML = list.length ? list.map((p) => `<li data-id="${p.id}">${p.name} <small>${p.county}${p.town}</small>
      <b>${stations.fmt(p.v)}${v.scale === 'wind' ? `（${p.bf}級）` : ` ${v.unit}`}</b>${p.gt ? ` <small>@${stations.fmtAt(p.gt)}</small>` : ''}</li>`).join('')
    : '<small>目前沒有資料</small>';
  for (const li of box.querySelectorAll('li')) li.onclick = () => openStation(li.dataset.id);
}

/** 縣市勾選 → 篩選;存「沒勾的縣市」,之後新出現的縣市預設顯示 */
function applyCounties() {
  const off = new Set([...$('st-counties').querySelectorAll('input')].filter((c) => !c.checked).map((c) => c.value));
  stations.setFilter({ countyOff: off });
  prefs.set('stCountyOff', [...off]);
  countySummary();
  render();
}

function countySummary() {
  const box = [...$('st-counties').querySelectorAll('input')], on = box.filter((c) => c.checked);
  $('st-county-sum').textContent = on.length === box.length ? '全部'
    : on.length <= 2 ? on.map((c) => c.value).join('、') || '未選' : `${on.length} / ${box.length}`;
}

function bindStationTools() {
  stations.setFilter({ countyOff: new Set(prefs.get('stCountyOff') ?? []) });
  const setAll = (on) => {
    for (const c of $('st-counties').querySelectorAll('input')) c.checked = on;
    applyCounties();
  };
  $('st-county-all').onclick = () => setAll(true);
  $('st-county-none').onclick = () => setAll(false);
  stations.showLabels = $('st-labels').checked;
  $('st-labels').onchange = (e) => { stations.showLabels = e.target.checked; stations.drawLabels(); };
  $('st-search').onchange = (e) => {
    const q = e.target.value.trim();
    const m = q.match(/（([^）]+)）$/);
    const id = m ? m[1] : [...stations.all.values()].find((s) => s.id === q || s.name === q)?.id;
    if (id) { openStation(id); e.target.value = ''; }
    else if (q) toast(`找不到測站「${q}」`, 2000);
  };
  for (const c of document.querySelectorAll('#st-types input')) {
    c.onchange = () => {
      const types = new Set([...document.querySelectorAll('#st-types input:checked')].map((x) => x.value));
      stations.setFilter({ types });
      render();
    };
  }
  for (const id of ['st-rank-on', 'st-rank-order', 'st-rank-n']) $(id).onchange = refreshStationUI;
}

/** 左側面板整個收合,與各圖層選項收合(狀態記在瀏覽器) */
function bindCollapse() {
  const panel = $('panel'), btn = document.createElement('button');
  btn.id = 'panel-toggle';
  panel.prepend(btn);
  const setPanel = (hide) => {
    panel.classList.toggle('collapsed', hide);
    btn.textContent = hide ? '☰ 圖層' : '«';
    btn.title = hide ? '展開選單' : '收合選單';
  };
  setPanel(!!prefs.get('panelHidden'));
  btn.onclick = () => { const hide = !panel.classList.contains('collapsed'); setPanel(hide); prefs.set('panelHidden', hide); };

  const folded = prefs.get('folded') ?? {};
  for (const layer of document.querySelectorAll('#panel .layer')) {
    const key = layer.dataset.layer, b = document.createElement('button');
    b.className = 'fold';
    const set = (f) => { layer.classList.toggle('folded', f); b.textContent = f ? '▸' : '▾'; b.title = f ? '展開選項' : '收合選項'; };
    set(!!folded[key]);
    b.onclick = (e) => {
      e.preventDefault();            // 在 label 裡:不要順便切換圖層開關
      const f = !layer.classList.contains('folded');
      set(f);
      folded[key] = f;
      prefs.set('folded', folded);
    };
    layer.querySelector('.layer-head').prepend(b);
  }
  syncLayerOff();
  document.addEventListener('change', (e) => { if (e.target.closest?.('.layer-head')) syncLayerOff(); });
}

/** 沒勾的圖層只留標題列(選項收起來),面板才不會太長 */
function syncLayerOff() {
  for (const layer of document.querySelectorAll('#panel .layer')) {
    layer.classList.toggle('off', !layer.querySelector('.layer-head input[type=checkbox]').checked);
  }
}

// ── 綁定 UI ──
function bindUI() {
  bindCollapse();
  $('btn-sync').onclick = () => {
    if (state.playing) return;
    setSync(!state.sync);
    if (!state.sync) state.T = latestSlot();
    render();
  };
  $('slider').oninput = (e) => { if (state.playing) stop(); goto(+e.target.value); };
  $('btn-prev').onclick = () => goto(state.slots.indexOf(state.T) - 1, -1);
  $('btn-next').onclick = () => goto(state.slots.indexOf(state.T) + 1, 1);
  $('btn-latest').onclick = () => goto(state.slots.length - 1, -1);
  $('btn-play').onclick = play;

  document.addEventListener('keydown', (e) => {
    if (['INPUT', 'SELECT'].includes(e.target.tagName) && e.target.type !== 'range') return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); $('btn-prev').click(); }
    if (e.key === 'ArrowRight') { e.preventDefault(); $('btn-next').click(); }
    if (e.key === ' ') { e.preventDefault(); play(); }
  });

  $('chk-radar').onchange = (e) => { radar.setVisible(e.target.checked); updateLegend(); refreshTimeline(); };
  bindStationUI();
  bindMarineUI();
  bindLegendScale();
  new Capture(map, toast);
  bindStationTools();
  bindSatUI();
  bindEcmwfUI();
  bindWindUI();
  pairNumbers();
  $('play-range').onchange = () => {
    if (state.playing) stop();
    buildSlots();
    refreshSlider();
    if (!state.slots.includes(state.T) || !ok(state.T)) state.T = latestSlot();
    render();
  };
  $('op-radar').oninput = (e) => radar.setOpacity(e.target.value / 100);
  $('chk-typhoon').onchange = (e) => { typhoon.setVisible(e.target.checked); updateLegend(); };
  $('ty-issue').onchange = (e) => { typhoon.fixedIssue = e.target.value; render(); };
  $('ty-cone').onchange = (e) => { typhoon.show_cone = e.target.checked; typhoon.draw(); updateLegend(); };
  for (const c of document.querySelectorAll('[data-ty-circle]')) {
    c.onchange = () => { typhoon.circles[c.dataset.tyCircle] = c.checked; typhoon.draw(); };
  }
  $('ty-circle-shape').onchange = (e) => { typhoon.circleShape = e.target.value; typhoon.draw(); };
  // 暴風圈:線寬、填色濃度,目前 / 預報分開設(過去各點同預報)
  const tyStyle = () => typhoon.setCircleStyle({
    nowWidth: +$('ty-w-now').value || 0, fcstWidth: +$('ty-w-fcst').value || 0,
    nowFill: +$('ty-fill-now').value, fcstFill: +$('ty-fill-fcst').value,
  });
  for (const id of ['ty-w-now', 'ty-w-fcst', 'ty-fill-now', 'ty-fill-fcst']) $(id).oninput = tyStyle;
  typhoon.onAnim = (on) => {
    $('ty-anim').classList.toggle('on', on);
    $('ty-anim').textContent = on ? '■ 停止動畫' : '▶ 路徑動畫';
  };
  $('ty-anim').onclick = () => {
    if (typhoon.raf) typhoon.animate(false);
    else if (!typhoon.animate(true)) toast(typhoon.visible ? '目前沒有颱風路徑' : '請先開啟颱風路徑', 2000);
  };
  typhoon.animSpeed = +$('ty-anim-speed').value;
  $('ty-anim-speed').onchange = (e) => { typhoon.animSpeed = +e.target.value; if (typhoon.raf) typhoon.animate(true); };
  $('ty-names').onchange = (e) => { typhoon.show_names = e.target.checked; typhoon.draw(); };
  $('ty-labels').onchange = (e) => { typhoon.show_labels = e.target.checked; typhoon.draw(); };
  $('basemap').onchange = (e) => setTheme(e.target.value);
  $('chk-grid').onchange = (e) => {
    for (const id of ['grid-major', 'grid-minor']) map.setLayoutProperty(id, 'visibility', e.target.checked ? 'visible' : 'none');
  };
  $('chk-county').onchange = (e) => {
    for (const id of ['county', 'county-casing']) map.setLayoutProperty(id, 'visibility', e.target.checked ? 'visible' : 'none');
  };
  $('chk-km100').onchange = (e) => {
    for (const id of ['km100', 'km100-casing']) map.setLayoutProperty(id, 'visibility', e.target.checked ? 'visible' : 'none');
  };
  $('btn-reset-prefs').onclick = () => { prefs.reset(); location.reload(); };
  map.on('moveend', () => {
    const c = map.getCenter();
    prefs.set('view', { center: [+c.lng.toFixed(4), +c.lat.toFixed(4)], zoom: +map.getZoom().toFixed(2) });
  });
  const saveEns = (e) => {
    if (!e.target.closest?.('#ens-models')) return;
    prefs.set('ensCfg', Object.fromEntries(Object.entries(ens.cfg).map(([m, c]) => [m, { ...c, init: undefined }])));
  };
  document.addEventListener('change', saveEns);
  document.addEventListener('input', saveEns);

  map.on('mousemove', (e) => {
    const v = [radar, ecmwf, wind, waves, satellite].map((l) => l.valueAt(e.lngLat.lng, e.lngLat.lat)).filter(Boolean).join('　');
    const el = $('readout');
    el.style.display = 'block';
    const lng = ((e.lngLat.lng + 180) % 360 + 360) % 360 - 180;   // 地圖往東捲過 180° 時 lng 會超過 180
    el.textContent = `${e.lngLat.lat.toFixed(3)}°N ${Math.abs(lng).toFixed(3)}°${lng < 0 ? 'W' : 'E'}${v ? `　${v}` : ''}`;
  });
  map.on('mouseout', () => { $('readout').style.display = 'none'; });
  window.addEventListener('resize', () => refreshSlider());
}

map.on('load', async () => {
  bindUI();
  bindEnsUI();
  setSync(true);
  await reload();
  radar.addTo();
  satellite.addTo('radar');
  ecmwf.addTo('radar');
  wind.addTo();
  waves.addTo();                // 後加的在下面:浪在風底下
  typhoon.addTo();
  ens.addTo('ty-cone-fill');
  addOverlays('ens-members');
  stations.addTo('ens-members');
  marine.addTo('ens-members');
  setTheme('light');
  prefs.restoreControls();     // 上次的設定(重新整理後還原)
  prefs.watchControls();
  updateLegend();
  await render();

  setInterval(async () => {
    if (state.playing) return;
    await reload();
    render();
  }, REFRESH_SEC * 1000);
});

// SW-Watch 主程式:地圖、圖層面板、時間軸(同步 / 不同步、對齊播放)
import { REFRESH_SEC, STEP_MIN, TIMELINE_DAYS } from './config.js';
import { addMin, diffMin, floorStep, fmtTW, fmtUTC, nowStamp } from './time.js';
import { RadarLayer } from './layers/radar.js';
import { category, TyphoonLayer } from './layers/typhoon.js';
import { EnsembleLayer, fmtInit, MODEL_COLORS, MODEL_NAMES } from './layers/ensemble.js';
import { getJSON } from './data.js';

const $ = (id) => document.getElementById(id);

// ── 底圖:素色向量(Natural Earth 10m + NCDR 縣市界,仿 notebook 的 cartopy 底圖)──
// 產生方式見 pipeline/build_basemap.py;另保留 Esri 衛星影像
const BASE = new URL('../assets/basemap/', import.meta.url).href;
const THEMES = {
  light: { bg: '#ffffff', land: '#f5f5f5', coast: '#000000', border: '#555555', county: '#000000', grid: 'rgba(0,0,0,0.18)', imagery: false },
  dark: { bg: '#1b1f26', land: '#2e333c', coast: '#a9b1bd', border: '#7d8590', county: '#c9d1dc', grid: 'rgba(255,255,255,0.12)', imagery: false },
  imagery: { bg: '#000000', land: '#000000', coast: '#ffffff', border: '#dddddd', county: '#ffffff', grid: 'rgba(255,255,255,0.25)', imagery: true },
};

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
  center: [121, 23.7],
  zoom: 6.2,
  attributionControl: { compact: true, customAttribution: '資料：中央氣象署、NCDR、ECMWF (CC BY 4.0)、NOAA NCEP、Google DeepMind WeatherLab' },
});

/** 海岸線、國界、縣市界、經緯網格疊在雷達上面(同 notebook:先畫資料再畫邊界) */
function addOverlays(beforeId) {
  const th = THEMES.light;
  map.addSource('coast', { type: 'geojson', data: `${BASE}coast.json` });
  map.addSource('borders', { type: 'geojson', data: `${BASE}borders.json` });
  map.addSource('county', { type: 'geojson', data: `${BASE}taiwan.json` });
  map.addSource('grid', { type: 'geojson', data: graticule() });
  map.addLayer({ id: 'grid-minor', type: 'line', source: 'grid', minzoom: 5.5, filter: ['!', ['get', 'major']],
    paint: { 'line-color': th.grid, 'line-width': 0.5 } }, beforeId);
  map.addLayer({ id: 'grid-major', type: 'line', source: 'grid', filter: ['get', 'major'],
    paint: { 'line-color': th.grid, 'line-width': 0.8 } }, beforeId);
  map.addLayer({ id: 'coast', type: 'line', source: 'coast', paint: { 'line-color': th.coast, 'line-width': 0.8 } }, beforeId);
  map.addLayer({ id: 'borders', type: 'line', source: 'borders', paint: { 'line-color': th.border, 'line-width': 0.7 } }, beforeId);
  map.addLayer({ id: 'county', type: 'line', source: 'county', paint: { 'line-color': th.county, 'line-width': 0.8 } }, beforeId);
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
  map.setPaintProperty('grid-major', 'line-color', th.grid);
  map.setPaintProperty('grid-minor', 'line-color', th.grid);
  typhoon.setTheme(name === 'light' ? 'light' : 'dark');
}

map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

const radar = new RadarLayer(map);
const typhoon = new TyphoonLayer(map);
const ens = new EnsembleLayer(map);
const LAYERS = [radar, typhoon, ens];

// ── 狀態 ──
const state = {
  sync: true,        // 同步:所有圖層對齊 T;不同步:各自最新
  T: null,           // 目前時間(UTC stamp)
  follow: true,      // T 停在最新時,有新資料自動往前
  slots: [],         // 時間軸每一格
  playing: false,
  playTimer: null,
  frames: [],
};

function enabled() { return LAYERS.filter((l) => l.visible && l.index); }

/** 時間軸範圍:最近 TIMELINE_DAYS 天內,從最早資料到最新資料,每 10 分一格 */
function buildSlots() {
  const all = LAYERS.flatMap((l) => l.times);
  if (!all.length) { state.slots = []; return; }
  const end = floorStep(all.reduce((a, b) => (a > b ? a : b)));
  const earliest = floorStep(all.reduce((a, b) => (a < b ? a : b)));
  const limit = addMin(end, -TIMELINE_DAYS * 1440);
  let t = earliest > limit ? earliest : limit;
  const slots = [];
  while (t <= end) { slots.push(t); t = addMin(t, STEP_MIN); }
  state.slots = slots;
}

// ── 畫面更新 ──
async function render() {
  const sync = state.sync || state.playing;
  updateClock();
  await Promise.all(LAYERS.map(async (l) => {
    if (!l.index) return;
    const stamp = l.pick(state.T, sync);
    try { await l.show(stamp); } catch (e) { console.warn(l.key, stamp, e); await l.show(null); }
    updateLayerTime(l, stamp, sync);
  }));
  if (!state.playing) renderStorms();
}

function updateLayerTime(l, stamp, sync) {
  const el = $(`time-${l.key}`);
  el.classList.remove('nodata', 'stale');
  if (!stamp) { el.textContent = '無資料'; el.classList.add('nodata'); return; }
  if (l.key === 'typhoon') {
    el.textContent = `初始 ${fmtTW(stamp)}`;
    return;
  }
  if (l.key === 'ens') {
    const inits = [...new Set(Object.values(ens.resolved))];
    el.textContent = inits.length === 1 ? `初始 ${fmtInit(inits[0])}` : inits.length ? '各模式不同' : '無資料';
    if (!inits.length) el.classList.add('nodata');
    updateEnsValidLabel();
    return;
  }
  const age = Math.round(diffMin(nowStamp(), stamp));
  el.textContent = fmtTW(stamp);
  if (!sync && age > 20) { el.textContent += `（${age} 分前）`; el.classList.add('stale'); }
}

function updateClock() {
  if (state.sync || state.playing) {
    $('clock-main').textContent = state.T ? `${fmtTW(state.T, 'full')}（台灣）` : '--';
    $('clock-sub').textContent = state.T ? `${fmtUTC(state.T)}　${state.playing ? '播放中（對齊）' : '同步模式'}` : '';
  } else {
    $('clock-main').textContent = '各圖層最新資料';
    $('clock-sub').textContent = '不同步模式：時間見左側各圖層';
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
  const rows = [[radar, '#4fc3f7'], [typhoon, '#ffd54f'], [ens, '#ef5350']];
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
  const every = hours <= 6 ? 60 : hours <= 24 ? 180 : hours <= 72 ? 720 : 1440; // 分鐘
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

function goto(i) {
  if (!state.slots.length) return;
  i = Math.max(0, Math.min(state.slots.length - 1, i));
  state.T = state.slots[i];
  state.follow = i === state.slots.length - 1;
  if (!state.sync) setSync(true);   // 拖動時間軸 = 指定時間 → 自動切到同步
  render();
}

// ── 播放(永遠對齊)──
async function play() {
  if (state.playing) return stop();
  const hours = +$('play-range').value;
  // 結尾 = 開啟中、固定週期圖層都有資料的最新時間
  const ends = enabled().filter((l) => l.cadence).map((l) => l.latest).filter(Boolean);
  const end = ends.length ? ends.reduce((a, b) => (a < b ? a : b)) : state.slots[state.slots.length - 1];
  const frames = state.slots.filter((t) => t <= end && t > addMin(end, -hours * 60));
  if (!frames.length) return;
  state.wasSync = state.sync;
  state.playing = true;
  $('btn-play').textContent = '⏸';
  if (radar.visible) {
    await radar.prefetch(frames.filter((t) => radar.times.includes(t)),
      (d, n) => toast(`載入雷達 ${d}/${n}`, d === n ? 600 : 0));
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
  if (!state.sync) state.T = state.slots[state.slots.length - 1];
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
  await loadBestTrack();
  if (!state.T || wasEnd || !state.slots.includes(state.T)) state.T = state.slots[state.slots.length - 1] ?? null;
}

function fillIssueSelect() {
  const sel = $('ty-issue');
  const cur = sel.value;
  sel.innerHTML = '<option value="">依時間軸</option>' +
    [...typhoon.times].reverse().map((t) => `<option value="${t}">${fmtTW(t)}（${t.slice(8, 10)}Z）</option>`).join('');
  sel.value = typhoon.times.includes(cur) ? cur : '';
}

// ── 系集面板 ──
const optInit = (i) => `<option value="${i}">${fmtInit(i)}（台灣 ${fmtTW(`${i}00`)}）</option>`;

function fillEnsPanel() {
  if (!ens.index) return;
  const tcSel = $('ens-tc');
  tcSel.innerHTML = Object.entries(ens.index.tcs ?? {}).map(([id, t]) => `<option value="${id}">${t.name_zh ?? ''} ${t.name_en ?? id}</option>`).join('');
  tcSel.value = ens.tc;

  const allInits = [...new Set(Object.values(ens.index.models).flat())].sort().reverse();
  const initSel = $('ens-init');
  initSel.innerHTML = '<option value="">依時間軸（最新）</option>' + allInits.map(optInit).join('');
  initSel.value = ens.baseInit;

  buildModelRows();

  const vs = $('ens-valid-start');
  vs.innerHTML = '<option value="">自動</option>' + ens.validChoices().map((t) => `<option value="${t}">${fmtTW(t)}（${t.slice(6, 8)}日${t.slice(8, 10)}Z）</option>`).join('');
  vs.value = ens.validStart;
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
        <select><option value="">同上</option>${[...ens.index.models[m]].reverse().map((i) => `<option value="${i}">${fmtInit(i)}</option>`).join('')}</select>
        <button class="expand">▸</button>
      </div>
      <div class="model-body" hidden>${body(c)}</div>`;
    const sel = row.querySelector('select');
    sel.value = c.init;
    row.querySelector('[data-on]').onchange = (e) => { c.on = e.target.checked; render(); };
    sel.onchange = () => { c.init = sel.value; render(); };
    bindBody(row, [m], false);
    box.appendChild(row);
  }
  for (const btn of box.querySelectorAll('.expand')) {
    btn.onclick = () => {
      const b = btn.closest('.model').querySelector('.model-body');
      b.hidden = !b.hidden;
      btn.textContent = b.hidden ? '▸' : '▾';
    };
  }
}

/** 「全部模式」改了設定後,把各模式列的勾選、tau、透明度更新成目前值 */
function syncRowsFromCfg() {
  for (const row of document.querySelectorAll('#ens-models .model[data-model]')) {
    const c = ens.cfg[row.dataset.model];
    for (const inp of row.querySelectorAll('[data-k]')) {
      const k = inp.dataset.k;
      if (k === 'opacity') inp.value = Math.round(c.opacity * 100);
      else if (k === 'tau0') inp.value = c.tau[0];
      else if (k === 'tau1') inp.value = c.tau[1];
      else inp.checked = c[k];
    }
  }
}

/** 有效時間「自動」顯示目前算出來的起點 */
function updateEnsValidLabel() {
  const opt = $('ens-valid-start').options[0];
  if (!opt) return;
  const s = ens.validStart ? null : ens.windowStart();
  opt.textContent = s ? `自動（${fmtTW(s)}）` : '自動';
}

/** 實際路徑:最新一次氣象署颱風資料裡的過去定位 */
async function loadBestTrack() {
  if (!typhoon.latest) return;
  try {
    const d = await getJSON(`typhoon/cwa_track/${typhoon.latest}.json`);
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
      updateEnsValidLabel();
    };
  }
  $('ens-valid-start').onchange = (e) => { ens.validStart = e.target.value; ens.draw(); updateEnsValidLabel(); };
  $('ens-valid-hours').onchange = (e) => { ens.validHours = +e.target.value; ens.draw(); };
  for (const c of document.querySelectorAll('[data-ens-opt]')) {
    c.onchange = () => { ens.opts[c.dataset.ensOpt] = c.checked; ens.draw(); };
  }
}

// ── 綁定 UI ──
function bindUI() {
  $('btn-sync').onclick = () => {
    if (state.playing) return;
    setSync(!state.sync);
    if (!state.sync) state.T = state.slots[state.slots.length - 1];
    render();
  };
  $('slider').oninput = (e) => { if (state.playing) stop(); goto(+e.target.value); };
  $('btn-prev').onclick = () => goto(state.slots.indexOf(state.T) - 1);
  $('btn-next').onclick = () => goto(state.slots.indexOf(state.T) + 1);
  $('btn-latest').onclick = () => goto(state.slots.length - 1);
  $('btn-play').onclick = play;

  document.addEventListener('keydown', (e) => {
    if (['INPUT', 'SELECT'].includes(e.target.tagName) && e.target.type !== 'range') return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); $('btn-prev').click(); }
    if (e.key === 'ArrowRight') { e.preventDefault(); $('btn-next').click(); }
    if (e.key === ' ') { e.preventDefault(); play(); }
  });

  $('chk-radar').onchange = (e) => { radar.setVisible(e.target.checked); $('legend').style.display = e.target.checked ? '' : 'none'; };
  $('op-radar').oninput = (e) => radar.setOpacity(e.target.value / 100);
  $('chk-typhoon').onchange = (e) => typhoon.setVisible(e.target.checked);
  $('ty-issue').onchange = (e) => { typhoon.fixedIssue = e.target.value; render(); };
  $('ty-cone').onchange = (e) => { typhoon.show_cone = e.target.checked; typhoon.draw(); };
  for (const c of document.querySelectorAll('[data-ty-circle]')) {
    c.onchange = () => { typhoon.circles[c.dataset.tyCircle] = c.checked; typhoon.draw(); };
  }
  $('ty-labels').onchange = (e) => { typhoon.show_labels = e.target.checked; typhoon.draw(); };
  $('basemap').onchange = (e) => setTheme(e.target.value);
  $('chk-grid').onchange = (e) => {
    for (const id of ['grid-major', 'grid-minor']) map.setLayoutProperty(id, 'visibility', e.target.checked ? 'visible' : 'none');
  };
  $('chk-county').onchange = (e) => map.setLayoutProperty('county', 'visibility', e.target.checked ? 'visible' : 'none');

  map.on('mousemove', (e) => {
    const v = radar.valueAt(e.lngLat.lng, e.lngLat.lat);
    const el = $('readout');
    el.style.display = 'block';
    el.textContent = `${e.lngLat.lat.toFixed(3)}°N ${e.lngLat.lng.toFixed(3)}°E${v ? `　${v}` : ''}`;
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
  typhoon.addTo();
  ens.addTo('ty-cone-fill');
  addOverlays('ens-members');
  setTheme('light');
  $('legend').innerHTML = radar.legend();
  await render();

  setInterval(async () => {
    if (state.playing) return;
    await reload();
    render();
  }, REFRESH_SEC * 1000);
});

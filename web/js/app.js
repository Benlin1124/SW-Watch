// SW-Watch 主程式:地圖、圖層面板、時間軸(同步 / 不同步、對齊播放)
import { REFRESH_SEC, STEP_MIN, TIMELINE_DAYS } from './config.js';
import { addMin, diffMin, floorStep, fmtTW, fmtUTC, nowStamp } from './time.js';
import { RadarLayer } from './layers/radar.js';
import { category, TyphoonLayer } from './layers/typhoon.js';
import { EnsembleLayer, fmtInit, MODEL_COLORS, MODEL_NAMES } from './layers/ensemble.js';
import { getJSON } from './data.js';

const $ = (id) => document.getElementById(id);

// ── 底圖(免金鑰的點陣圖磚;CARTO 已改為需要金鑰,改用 Esri)──
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';
const BASEMAPS = {
  dark: { tiles: [`${ESRI}/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`],
    labels: `${ESRI}/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`, maxzoom: 16 },
  light: { tiles: [`${ESRI}/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}`],
    labels: `${ESRI}/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}`, maxzoom: 16 },
  imagery: { tiles: [`${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`],
    labels: `${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`, maxzoom: 18 },
};
const ATTRIBUTION = 'Basemap © Esri';

const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    sources: Object.fromEntries(Object.entries(BASEMAPS).flatMap(([k, b]) => [
      [`base-${k}`, { type: 'raster', tileSize: 256, tiles: b.tiles, maxzoom: b.maxzoom, attribution: ATTRIBUTION }],
      [`label-${k}`, { type: 'raster', tileSize: 256, tiles: [b.labels], maxzoom: b.maxzoom }],
    ])),
    layers: Object.keys(BASEMAPS).map((k) => ({
      id: `base-${k}`, type: 'raster', source: `base-${k}`, layout: { visibility: k === 'dark' ? 'visible' : 'none' },
    })),
  },
  center: [121, 23.7],
  zoom: 6.2,
  attributionControl: { compact: true, customAttribution: '資料：中央氣象署' },
});
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
    el.textContent = `發布 ${fmtTW(stamp)}`;
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
    [...typhoon.times].reverse().map((t) => `<option value="${t}">${fmtTW(t, 'full')}</option>`).join('');
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

  const box = $('ens-models');
  box.innerHTML = '';
  for (const m of ens.models) {
    const row = document.createElement('div');
    row.className = 'model-row';
    row.innerHTML = `<label title="${MODEL_NAMES[m] ?? m}"><input type="checkbox" ${ens.modelOn[m] ? 'checked' : ''}>
      <span class="swatch" style="background:${MODEL_COLORS[m] ?? '#ccc'}"></span>${m}</label>
      <select><option value="">同上</option>${[...ens.index.models[m]].reverse().map((i) => `<option value="${i}">${fmtInit(i)}</option>`).join('')}</select>`;
    const [chk, sel] = [row.querySelector('input'), row.querySelector('select')];
    sel.value = ens.modelInit[m];
    chk.onchange = () => { ens.modelOn[m] = chk.checked; render(); };
    sel.onchange = () => { ens.modelInit[m] = sel.value; render(); };
    box.appendChild(row);
  }

  const vs = $('ens-valid-start');
  vs.innerHTML = '<option value="">自動</option>' + ens.validChoices().map((t) => `<option value="${t}">${fmtTW(t)}（${t.slice(6, 8)}日${t.slice(8, 10)}Z）</option>`).join('');
  vs.value = ens.validStart;
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
      $('ens-tau-box').hidden = ens.mode !== 'tau';
      $('ens-valid-box').hidden = ens.mode !== 'valid';
      ens.draw();
      updateEnsValidLabel();
    };
  }
  const tauChange = () => {
    let a = +$('ens-tau-a').value, b = +$('ens-tau-b').value;
    if (a > b) [a, b] = [b, a];
    ens.tauRange = [a, b];
    ens.draw();
  };
  $('ens-tau-a').onchange = tauChange;
  $('ens-tau-b').onchange = tauChange;
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
  $('ty-circle').onchange = (e) => { typhoon.show_circle = e.target.checked; typhoon.draw(); };
  $('ty-labels').onchange = (e) => { typhoon.show_labels = e.target.checked; typhoon.draw(); };
  $('basemap').onchange = (e) => {
    for (const k of Object.keys(BASEMAPS)) {
      for (const p of ['base', 'label']) map.setLayoutProperty(`${p}-${k}`, 'visibility', k === e.target.value ? 'visible' : 'none');
    }
  };

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
  for (const k of Object.keys(BASEMAPS)) {   // 地名、行政界線疊在雷達上面
    map.addLayer({ id: `label-${k}`, type: 'raster', source: `label-${k}`, layout: { visibility: k === 'dark' ? 'visible' : 'none' } }, 'ens-members');
  }
  $('legend').innerHTML = radar.legend();
  await render();

  setInterval(async () => {
    if (state.playing) return;
    await reload();
    render();
  }, REFRESH_SEC * 1000);
});

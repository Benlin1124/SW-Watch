// 預報資訊卡:模式預報圖層開著時,點地圖(測站、浮標、颱風、系集以外的地方)打開
// 該點各模式的時序(報別選單:最新一報,或指定起報時間 → 各模式在那之前最新的一報),同一張圖比較 ECMWF IFS / AIFS / 氣象署 3 km / 氣象署海浪 / CorrDiff(IFS、AIFS)(uPlot)
// 點圖 → 模式預報圖層跳到那個時刻(onPick);白色虛線 = 地圖目前顯示的預報時刻
// 取最近的格點(和滑鼠讀值相同);海浪近岸沒有值 → 取 FILL_ITERS 格內最近有值的格,標「近岸外推」
import { ALL_MODELS, MODELS, MIN_DBZ, fmtEcInit } from './layers/ecmwf.js';
import { bfLabel } from './colormaps.js';
import { enableZoom } from './chart_zoom.js';
import { toDate, toStamp, fmtTW } from './time.js';
import { townAt } from './town.js';

export const COLORS = { ecmwf: '#ffb74d', aifs: '#ce93d8', wrf: '#4fc3f7', cwawave: '#81c784', cdifs: '#ff5252', cdaifs: '#f8f06a' };
const WAVE = new Set(['swh', 'pp1d', 'mwp']);
const FILL_ITERS = 3;
// 分頁:每條線 = 一個模式的一個量(dash = 虛線);rain6 = 前 6 小時雨量(階梯線,值畫在那 6 小時)
const TABS = {
  rain: { name: '雨量', unit: 'mm', lines: [{ v: 'rain6', label: '6 小時雨量' }] },
  mrr: { name: '回波', unit: 'dBZ', lines: [{ v: 'mrr', label: '最大回波' }] },
  t2: { name: '溫度', unit: '°C', lines: [{ v: 't2', label: '溫度' }] },
  msl: { name: '氣壓', unit: 'hPa', lines: [{ v: 'msl', label: '氣壓' }] },
  wind: { name: '風', unit: 'm/s', lines: [{ v: 'wind', label: '平均風' }, { v: 'gust', label: '陣風', dash: true }] },
  swh: { name: '浪高', unit: 'm', lines: [{ v: 'swh', label: '浪高' }] },
  per: { name: '週期', unit: 's', lines: [{ v: 'mwp', label: '平均週期' }, { v: 'pp1d', label: '尖峰週期', dash: true }] },
};
const VAR_TAB = { rain: 'rain', mrr: 'mrr', t2: 't2', msl: 'msl', wind: 'wind', gust: 'wind', swh: 'swh', pp1d: 'per', mwp: 'per' };
const HAS = (m, v) => {
  const vars = ALL_MODELS[m].vars;
  return v === 'rain6' || v === 'rain1' ? vars.includes('rain') : v === 'pstn' ? vars.includes('msl') : vars.includes(v);
};
const toSec = (s) => toDate(s).getTime() / 1000;
const stampOf = (sec) => toStamp(new Date(sec * 1000));
/** 系集範圍(最大、最小):只畫色帶,圖例不另列,數值併在平均那一列(rangeValue);回傳 uPlot bands 用的項目 */
function pushRange(data, series, ys, name, m, value, scale) {
  const hi = series.length;
  for (const [k, label] of [['hi', '最大'], ['lo', '最小']]) {
    data.push(ys[k]);
    series.push({ label: `${name} 系集${label}`, stroke: 'transparent', width: 0, spanGaps: true, scale, points: { show: false }, value });
  }
  return { series: [hi, hi + 1], fill: `${COLORS[m]}38` };
}
/** 系集平均的圖例數值:平均(最小–最大);最大、最小緊接在平均後面兩個 series */
const rangeValue = (base) => (u, v, si, i) => (v == null ? '—' : `${base(u, v)}（${fmt(u.data[si + 2][i])}–${fmt(u.data[si + 1][i])}）`);
/** 圖例和游標圓點不顯示系集最大、最小(色帶本身留著) */
export function hideRange(u) {
  const rows = u.root.querySelectorAll('.u-legend .u-series'), pts = u.root.querySelectorAll('.u-cursor-pt');
  u.series.forEach((s, i) => {
    if (!/系集(最大|最小)$/.test(s.label ?? '')) return;
    if (rows[i]) rows[i].style.display = 'none';
    if (pts[i - 1]) pts[i - 1].style.display = 'none';
  });
}
const RUN_MAX = 16;          // 報別選單最多列幾報
/** 報別:run = '' → 模式 m 最新一報;run = 起報時間 → m 在那之前(含)最新的一報(各模式起報時刻不同);沒有 → null */
export function initFor(ec, m, run) {
  const x = ec.idx(m);
  if (!x?.latest) return null;
  if (!run) return x.latest;
  const t = toSec(run);
  return ec.initsOf(m).find((s) => toSec(s) <= t) ?? null;
}
/** 報別選單:models 起報時間的聯集(新 → 舊);選過的報別已不在 → 改回最新;回傳目前的報別 */
export function fillRuns(sel, ec, models, run) {
  const all = [...new Set(models.flatMap((m) => ec.initsOf(m)))].sort((a, b) => toSec(b) - toSec(a)).slice(0, RUN_MAX);
  if (run && !all.includes(run)) run = '';
  sel.innerHTML = '<option value="">最新一報</option>' + all.map((t) => `<option value="${t}">${fmtEcInit(t)} 報</option>`).join('');
  sel.value = run;
  return run;
}
const fmt = (x, d = 1) => (x == null || Number.isNaN(x) ? '—' : x.toFixed(d));
const max = (a) => a.reduce((m, x) => (x != null && !Number.isNaN(x) && x > m ? x : m), -Infinity);
const min = (a) => a.reduce((m, x) => (x != null && !Number.isNaN(x) && x < m ? x : m), Infinity);

export class ForecastCard {
  el = document.getElementById('fc-card');
  pt = null;                 // { lon, lat }
  tab = 'rain';
  T = null;
  plot = null;
  marker = null;
  seq = 0;
  zoom = { xr: null };       // 時間軸縮放範圍(換分頁留著,換地點還原)
  run = '';                  // 報別('' = 各模式最新一報)

  constructor(ec, map, { onOpen, onPick } = {}) {
    this.ec = ec;
    this.map = map;
    this.onOpen = onOpen;
    this.onPick = onPick;     // (UTC 秒) → 模式預報跳到那個時刻
    this.el.querySelector('#fc-close').onclick = () => this.close();
    const tabs = this.el.querySelector('.sc-tabs');
    tabs.innerHTML = Object.entries(TABS).map(([k, t]) => `<button data-tab="${k}">${t.name}</button>`).join('');
    for (const b of tabs.querySelectorAll('[data-tab]')) b.onclick = () => { this.tab = b.dataset.tab; this.drawChart(); };
    this.runSel = Object.assign(document.createElement('select'), { id: 'fc-run', title: '報別：最新一報，或指定起報時間（各模式取那之前最新的一報）' });
    tabs.append(this.runSel);
    this.runSel.onchange = () => { this.run = this.runSel.value; this.zoom.xr = null; this.refresh(); };
  }

  get models() { return Object.keys(ALL_MODELS).filter((m) => initFor(this.ec, m, this.run)); }

  /** 換報別:表和圖重畫 */
  async refresh() {
    if (!this.pt) return;
    const seq = ++this.seq;
    this.el.querySelector('#fc-now').innerHTML = '<div class="sc-nodata">載入中…</div>';
    await this.drawChart();
    if (seq === this.seq) await this.summary(seq);
  }

  async open(lon, lat, T) {
    this.pt = { lon, lat };
    this.zoom.xr = null;
    this.T = T;
    this.tab = VAR_TAB[this.ec.variable] ?? this.tab;
    this.onOpen?.();
    this.el.hidden = false;
    (this.marker ??= new maplibregl.Marker({ color: '#00e5ff', scale: 0.7 })).setLngLat([lon, lat]).addTo(this.map);
    this.el.querySelector('#fc-title').textContent = `預報　${lat.toFixed(2)}°N ${lon.toFixed(2)}°E`;
    const land = this.ec.land?.isLand(lon, lat);
    this.el.querySelector('#fc-sub').textContent = `${townAt(lon, lat) || (land ? '陸地' : '海上')}${land ? '（沒有海浪）' : ''}`;
    this.run = fillRuns(this.runSel, this.ec, Object.keys(ALL_MODELS).filter((m) => this.ec.idx(m)?.latest), this.run);
    await this.refresh();
  }

  close() {
    this.el.hidden = true;
    this.pt = null;
    this.seq++;
    this.plot?.destroy();
    this.plot = null;
    this.marker?.remove();
  }

  /** 時間軸移動:圖上的時間線跟著移 */
  update(T) {
    if (!this.pt) return;
    this.T = T;
    this.plot?.redraw(false);
  }

  series(m, v) { return pointSeries(this.ec, m, v, this.pt.lon, this.pt.lat, 0, this.run); }

  /** 上半部:各模式(所選報別)的摘要表(模式一列) */
  async summary(seq) {
    const rows = await Promise.all(this.models.map(async (m) => {
      const get = (v) => this.series(m, v).catch(() => null);
      const top = (s) => s.hi ?? s.ys, low = (s) => s.lo ?? s.ys;             // 有系集就看系集範圍
      const [rain, mrr, t2, wind, gust, swh] = await Promise.all(['rain6', 'mrr', 't2', 'wind', 'gust', 'swh'].map(get));
      const init = initFor(this.ec, m, this.run), steps = this.ec.stepsOf(m, init), days = steps[steps.length - 1] / 24;
      const total = rain && rain.ys.reduce((a, y) => a + (y ?? 0), 0);
      const cells = [
        `${fmtEcInit(init)}<small>${+days.toFixed(1)} 天</small>`,
        rain ? fmt(total, 0) : '—',
        mrr ? (max(top(mrr)) < MIN_DBZ ? '無' : fmt(max(top(mrr)), 0)) : '—',
        t2 ? `${fmt(min(low(t2)))}–${fmt(max(top(t2)))}` : '—',
        wind ? `${fmt(max(top(wind)))}<small>${bfLabel(max(top(wind)))} 級</small>` : '—',
        gust ? fmt(max(gust.ys)) : '—',
        swh ? `${fmt(max(swh.ys))}${swh.coast ? '<small>外推</small>' : ''}` : '—',
      ];
      return `<tr><th><i style="background:${COLORS[m]}"></i>${ALL_MODELS[m].name}</th>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
    }));
    if (seq !== this.seq) return;
    this.el.querySelector('#fc-now').innerHTML = '<table><thead><tr><th>模式</th><th>起報</th><th>雨量 mm</th><th>最大回波 dBZ</th>'
      + '<th>溫度 °C</th><th>最大風 m/s</th><th>陣風</th><th>最大浪 m</th></tr></thead>'
      + `<tbody>${rows.join('')}</tbody></table>`
      + `<div class="sc-obs">${this.run ? `各模式在 ${fmtEcInit(this.run)} 之前最新的一報` : '各模式最新一報'}、整段預報期間：雨量 = 累積，溫度 = 最低–最高；「外推」= 近岸取最近的外海格點；CorrDiff 只有台灣附近，是實驗產品，數值含 16 個樣本的範圍</div>`;
  }

  async drawChart() {
    for (const b of this.el.querySelectorAll('[data-tab]')) b.classList.toggle('on', b.dataset.tab === this.tab);
    const box = this.el.querySelector('#fc-chart'), note = this.el.querySelector('#fc-note');
    const tab = TABS[this.tab], pt = this.pt, seq = this.seq;
    const jobs = [];
    for (const l of tab.lines) for (const m of this.models) if (HAS(m, l.v)) jobs.push({ m, l, p: this.series(m, l.v).catch(() => null) });
    const got = (await Promise.all(jobs.map((j) => j.p))).map((s, k) => ({ ...jobs[k], s })).filter((j) => j.s);
    if (this.pt !== pt || seq !== this.seq) return;
    this.plot?.destroy();
    this.plot = null;
    box.innerHTML = '';
    if (!got.length) {
      box.innerHTML = `<div class="sc-nodata">這一點沒有${tab.name}預報${WAVE.has(tab.lines[0].v) ? '（陸地或模式範圍外）' : ''}</div>`;
      note.textContent = '';
      return;
    }
    // 各模式時刻不同(3 / 6 / 1 小時):x 取聯集,沒有的填 null,線跨過空缺
    const xs = [...new Set(got.flatMap((j) => j.s.xs))].sort((a, b) => a - b), pos = new Map(xs.map((x, i) => [x, i]));
    const data = [xs], series = [{ label: '時間', value: (u, v) => (v == null ? '—' : fmtTW(stampOf(v))) }];
    const bands = [], at = (arr, s) => { const y = new Array(xs.length).fill(null); s.xs.forEach((x, k) => { y[pos.get(x)] = arr[k]; }); return y; };
    const value = (u, v) => (v == null ? '—' : this.tab === 'wind' ? `${v.toFixed(1)}（${bfLabel(v)}級）` : `${v.toFixed(1)} ${tab.unit}`);
    for (const { m, l, s } of got) {
      data.push(at(s.ys, s));
      const name = ALL_MODELS[m].name;
      const label = `${name}${s.hi ? ' 系集' : tab.lines.length > 1 ? ` ${l.label}` : ''}`;
      series.push({
        label, stroke: COLORS[m], width: 1.6, dash: l.dash ? [4, 3] : undefined, spanGaps: true,
        paths: l.v === 'rain6' ? uPlot.paths.stepped({ align: -1 }) : undefined,
        points: { show: false }, value: s.hi ? rangeValue(value) : value,
      });
      if (s.hi) bands.push(pushRange(data, series, { hi: at(s.hi, s), lo: at(s.lo, s) }, name, m, value));
    }
    const coast = got.some((j) => j.s.coast);
    note.textContent = (this.tab === 'rain' ? '每 6 小時累積雨量（階梯線畫在那 6 小時）；' : '')
      + (this.tab === 'wind' ? '陣風只有 IFS（90 小時內前 1 小時最大、之後前 3 / 6 小時最大）；' : '')
      + (this.tab === 'mrr' ? `最大回波只有 CorrDiff，低於 ${MIN_DBZ} dBZ 畫成 0；` : '')
      + (got.some((j) => j.s.hi) ? 'CorrDiff 系集：線 = 16 個樣本平均，色帶與括號 = 最小到最大（只反映降尺度的不確定性）；' : got.some((j) => ALL_MODELS[j.m].perStep) ? 'CorrDiff 只取樣一次，是一種可能結果；' : '')
      + (coast ? '近岸沒有值，取最近的外海格點（近岸外推）；' : '')
      + '青線 = 時間軸目前時間，白虛線 = 地圖顯示的預報時刻；點圖跳到那個時刻；拖曳或滾輪縮放，雙擊還原';

    const axisStyle = { stroke: '#9aa3b2', grid: { stroke: 'rgba(255,255,255,0.08)' }, ticks: { stroke: 'rgba(255,255,255,0.15)' } };
    const tick = (t) => { const s = fmtTW(stampOf(t), 'dh'); return s.endsWith('00時') ? s.replace('00時', '') : s.replace(/^\d+日/, ''); };
    const zero = this.tab === 'rain' || this.tab === 'swh' || this.tab === 'mrr';
    const cardT = () => this.T, ec = this.ec;
    this.plot = new uPlot({
      width: box.clientWidth || 400, height: 220, series, bands,
      scales: { x: { time: true }, y: { auto: true, range: zero ? (u, lo, hi) => [0, Math.max(hi * 1.05, 1)] : undefined } },
      axes: [{ ...axisStyle, space: 45, values: (u, ticks) => ticks.map(tick) }, { ...axisStyle, label: tab.unit, size: 50 }],
      tzDate: (ts) => uPlot.tzDate(new Date(ts * 1e3), 'Asia/Taipei'),
      cursor: { drag: { x: true, y: false, setScale: true } },
      legend: { live: true },
      hooks: {
        draw: [(u) => {
          const vline = (t, color, dash) => {
            const x = u.valToPos(t, 'x', true);
            if (x < u.bbox.left || x > u.bbox.left + u.bbox.width) return;
            const c = u.ctx;
            c.save();
            c.strokeStyle = color;
            c.lineWidth = 1.5 * devicePixelRatio;
            c.setLineDash(dash.map((d) => d * devicePixelRatio));
            c.beginPath(); c.moveTo(x, u.bbox.top); c.lineTo(x, u.bbox.top + u.bbox.height); c.stroke();
            c.restore();
          };
          const s = ec.visible && ec.shown;
          if (s) vline(toSec(ec.validOf(s.init, s.step)), '#ffffff', [4, 3]);
          const T = cardT();
          if (T) vline(toSec(T), '#00e5ff', []);
        }],
      },
    }, data, box);
    hideRange(this.plot);
    const wasDrag = enableZoom(this.plot, this.zoom);
    this.plot.over.style.cursor = 'pointer';
    this.plot.over.addEventListener('click', () => {
      const u = this.plot, i = u?.cursor.idx;
      if (i != null && !wasDrag()) this.onPick?.(u.data[0][i]);
    });
  }
}

/** 模式 m 的報別 run(initFor;'' = 最新一報)、變數 v 在 (lon, lat) 的時序 → { init, xs(UTC 秒), ys, coast } 或 null(測站資訊卡也用)
 *  rain6 = 前 6 小時雨量;rain1 = 每個預報間隔的平均每小時雨量;pstn = 海平面氣壓換算到高度 alt(m)的氣壓 */
export async function pointSeries(ec, m, v, lon, lat, alt = 0, run = '') {
  const x = ec.idx(m), init = initFor(ec, m, run);
  if (!init || !HAS(m, v)) return null;
  const { grid: g, tile } = ec.pointView(m, init, lon, lat);     // IFS:那一點所在的 0.1° 分塊
  let ix = Math.round((lon - g.lon0) / g.dx), iy = Math.round((lat - g.lat0) / g.dy);
  if (ix < 0 || iy < 0 || ix >= g.nx || iy >= g.ny) return null;
  const steps = ec.stepsOf(m, init), n = g.nx * g.ny;
  const perStep = ALL_MODELS[m].perStep;
  if (perStep) {                           // CorrDiff:每個時刻一個檔,風速直接存
    // 這一報有系集 → 只畫系集完成的時刻(不和單一樣本接在一起);還沒有 → 第 1 個樣本
    const i = iy * g.nx + ix, t0 = toSec(init), nEns = x.ens_nsteps?.[init] ?? 0, use = nEns ? steps.slice(0, nEns) : steps;
    const read = (kind) => Promise.all(use.map(async (s) => {
      const { raw: r, spec } = await ec.stepData(init, v, s, m, nEns ? kind : '');
      const q = r[i];
      if (q === spec.nodata || q === undefined) return null;
      const y = q * spec.scale + spec.offset;
      return v === 'mrr' && y < MIN_DBZ ? 0 : y;
    }));
    const ys = await read('mean');
    if (!ys.some((y) => y != null)) return null;   // 全空 = 範圍外
    const out = { init, xs: use.map((s) => t0 + s * 3600), ys, coast: false };
    if (nEns) [out.lo, out.hi] = await Promise.all([read('min'), read('max')]);
    return out;
  }
  const raw = async (name) => {
    const { raw: r, spec } = await ec.data(init, name, m, tile);
    return (k, i) => { const q = r[k * n + i]; return q === spec.nodata || q === undefined ? NaN : q * spec.scale + spec.offset; };
  };
  let coast = false;
  if (WAVE.has(v)) {
    if (ec.land?.isLand(lon, lat)) return null;
    const get = await raw(v);
    if (Number.isNaN(get(0, iy * g.nx + ix))) {          // 近岸沒有值:找 FILL_ITERS 格內最近有值的格
      let best = null;
      for (let dy = -FILL_ITERS; dy <= FILL_ITERS; dy++) {
        for (let dx = -FILL_ITERS; dx <= FILL_ITERS; dx++) {
          const jx = ix + dx, jy = iy + dy, d = dx * dx + dy * dy;
          if (jx < 0 || jy < 0 || jx >= g.nx || jy >= g.ny || (best && best.d <= d)) continue;
          if (!Number.isNaN(get(0, jy * g.nx + jx))) best = { jx, jy, d };
        }
      }
      if (!best) return null;
      ({ jx: ix, jy: iy } = best);
      coast = true;
    }
  }
  const i = iy * g.nx + ix, t0 = toSec(init);
  let xs = steps.map((s) => t0 + s * 3600), ys;
  if (v === 'rain6') {
    const tp = await raw('tp'), at = new Map(steps.map((s, k) => [s, k]));
    const keep = steps.filter((s) => s >= 6 && s % 6 === 0 && at.has(s - 6));
    xs = keep.map((s) => t0 + s * 3600);
    ys = keep.map((s) => Math.max(tp(at.get(s), i) - tp(at.get(s - 6), i), 0));
  } else if (v === 'rain1') {
    const tp = await raw('tp');
    xs = xs.slice(1);
    ys = steps.slice(1).map((s, k) => Math.max(tp(k + 1, i) - tp(k, i), 0) / (s - steps[k]));
  } else if (v === 'pstn') {               // 測高公式:p = msl·exp(−g z / (Rd T)),T 取 2 m 溫度加半層的遞減率
    const [p, t] = await Promise.all([raw('msl'), raw('t2')]);
    ys = steps.map((s, k) => p(k, i) * Math.exp((-9.80665 * alt) / (287.05 * (t(k, i) + 273.15 + 0.00325 * alt))));
  } else if (v === 'wind') {
    const [u, w] = await Promise.all([raw('u10'), raw('v10')]);
    ys = steps.map((s, k) => Math.hypot(u(k, i), w(k, i)));
  } else {
    const get = await raw(v);
    ys = steps.map((s, k) => get(k, i));
  }
  ys = ys.map((y) => (Number.isNaN(y) ? null : y));
  return { init, xs, ys, coast };
}

// ── 測站 / 海象資訊卡疊加預報(虛線)──
export const FC_HOURS = { 0: '不疊預報', 24: '預報 1 天', 72: '預報 3 天', 168: '預報 7 天' };

/** lines [{ v, label, scale?, dash? }] × 各模式(報別 run)→ 有值的 [{ m, l, s }];corrdiff = 連 CorrDiff 一起(測站卡) */
export async function overlayLines(ec, lines, lon, lat, alt = 0, { corrdiff = false, run = '' } = {}) {
  const jobs = lines.flatMap((l) => Object.keys(corrdiff ? ALL_MODELS : MODELS).map((m) => ({ m, l, p: pointSeries(ec, m, l.v, lon, lat, alt, run).catch(() => null) })));
  return (await Promise.all(jobs.map((j) => j.p))).map((s, k) => ({ ...jobs[k], s })).filter((j) => j.s?.ys.some((y) => y != null));
}

/** 預報線併進 uPlot 的 data / series:x 和觀測取聯集(只留 from < x ≤ to;預報都在整點,觀測不會斷開)
 *  fmtValue(v, l) → 圖例的數值文字 */
export function mergeOverlay(data, series, fc, from, to, fmtValue) {
  if (!fc.length) return [];
  const xs = data[0];
  const all = [...new Set([...xs, ...fc.flatMap((j) => j.s.xs.filter((x) => x > from && x <= to))])].sort((a, b) => a - b);
  const at = new Map(all.map((x, i) => [x, i]));
  for (let c = 1; c < data.length; c++) {
    const col = new Array(all.length).fill(null);
    xs.forEach((x, i) => { col[at.get(x)] = data[c][i]; });
    data[c] = col;
  }
  data[0] = all;
  const bands = [];
  for (const { m, l, s } of fc) {
    const line = (arr) => { const col = new Array(all.length).fill(null); s.xs.forEach((x, k) => { if (at.has(x)) col[at.get(x)] = arr[k]; }); return col; };
    const value = (u, v) => (v == null ? '—' : fmtValue(v, l)), name = ALL_MODELS[m].name;
    data.push(line(s.ys));
    series.push({
      label: `${name}${s.hi ? ' 系集' : ''}${l.label}`, stroke: COLORS[m], width: 1.4, dash: l.dash ?? [5, 3],
      scale: l.scale ?? 'y', spanGaps: true, points: { show: false },
      paths: l.v === 'rain1' ? uPlot.paths.stepped({ align: -1 }) : undefined,
      value: s.hi ? rangeValue(value) : value,
    });
    if (s.hi) bands.push(pushRange(data, series, { hi: line(s.hi), lo: line(s.lo) }, name, m, value, l.scale ?? 'y'));
  }
  return bands;
}

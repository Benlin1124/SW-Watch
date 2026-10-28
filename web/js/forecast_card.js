// 預報資訊卡:模式預報圖層開著時,點地圖(測站、浮標、颱風、系集以外的地方)打開
// 該點各模式最新一報的時序,同一張圖比較 ECMWF IFS / AIFS / 氣象署 3 km / 氣象署海浪(uPlot)
// 點圖 → 模式預報圖層跳到那個時刻(onPick);白色虛線 = 地圖目前顯示的預報時刻
// 取最近的格點(和滑鼠讀值相同);海浪近岸沒有值 → 取 FILL_ITERS 格內最近有值的格,標「近岸外推」
import { MODELS, fmtEcInit } from './layers/ecmwf.js';
import { bfLabel } from './colormaps.js';
import { toDate, toStamp, fmtTW } from './time.js';

const COLORS = { ecmwf: '#ffb74d', aifs: '#ce93d8', wrf: '#4fc3f7', cwawave: '#81c784' };
const WAVE = new Set(['swh', 'pp1d', 'mwp']);
const FILL_ITERS = 3;
// 分頁:每條線 = 一個模式的一個量(dash = 虛線);rain6 = 前 6 小時雨量(階梯線,值畫在那 6 小時)
const TABS = {
  rain: { name: '雨量', unit: 'mm', lines: [{ v: 'rain6', label: '6 小時雨量' }] },
  t2: { name: '溫度', unit: '°C', lines: [{ v: 't2', label: '溫度' }] },
  msl: { name: '氣壓', unit: 'hPa', lines: [{ v: 'msl', label: '氣壓' }] },
  wind: { name: '風', unit: 'm/s', lines: [{ v: 'wind', label: '平均風' }, { v: 'gust', label: '陣風', dash: true }] },
  swh: { name: '浪高', unit: 'm', lines: [{ v: 'swh', label: '浪高' }] },
  per: { name: '週期', unit: 's', lines: [{ v: 'mwp', label: '平均週期' }, { v: 'pp1d', label: '尖峰週期', dash: true }] },
};
const VAR_TAB = { rain: 'rain', t2: 't2', msl: 'msl', wind: 'wind', gust: 'wind', swh: 'swh', pp1d: 'per', mwp: 'per' };
const HAS = (m, v) => {
  const vars = MODELS[m].vars;
  return v === 'rain6' ? vars.includes('rain') : vars.includes(v);
};
const toSec = (s) => toDate(s).getTime() / 1000;
const stampOf = (sec) => toStamp(new Date(sec * 1000));
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

  constructor(ec, map, { onOpen, onPick } = {}) {
    this.ec = ec;
    this.map = map;
    this.onOpen = onOpen;
    this.onPick = onPick;     // (UTC 秒) → 模式預報跳到那個時刻
    this.el.querySelector('#fc-close').onclick = () => this.close();
    const tabs = this.el.querySelector('.sc-tabs');
    tabs.innerHTML = Object.entries(TABS).map(([k, t]) => `<button data-tab="${k}">${t.name}</button>`).join('');
    for (const b of tabs.querySelectorAll('[data-tab]')) b.onclick = () => { this.tab = b.dataset.tab; this.drawChart(); };
  }

  get models() { return Object.keys(MODELS).filter((m) => this.ec.idx(m)?.latest); }

  async open(lon, lat, T) {
    this.pt = { lon, lat };
    this.T = T;
    this.tab = VAR_TAB[this.ec.variable] ?? this.tab;
    this.onOpen?.();
    this.el.hidden = false;
    (this.marker ??= new maplibregl.Marker({ color: '#00e5ff', scale: 0.7 })).setLngLat([lon, lat]).addTo(this.map);
    this.el.querySelector('#fc-title').textContent = `預報　${lat.toFixed(2)}°N ${lon.toFixed(2)}°E`;
    this.el.querySelector('#fc-sub').textContent = this.ec.land?.isLand(lon, lat) ? '陸地（沒有海浪）' : '海上';
    const seq = ++this.seq;
    this.el.querySelector('#fc-now').innerHTML = '<div class="sc-nodata">載入中…</div>';
    await this.drawChart();
    if (seq === this.seq) await this.summary(seq);
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

  /** 模式 m 最新一報、變數 v 在這一點的時序 → { init, xs(UTC 秒), ys, coast } 或 null */
  async series(m, v) {
    const ec = this.ec, x = ec.idx(m), init = x?.latest;
    if (!init || !HAS(m, v)) return null;
    const g = x.grid, { lon, lat } = this.pt;
    let ix = Math.round((lon - g.lon0) / g.dx), iy = Math.round((lat - g.lat0) / g.dy);
    if (ix < 0 || iy < 0 || ix >= g.nx || iy >= g.ny) return null;
    const steps = ec.stepsOf(m, init), n = g.nx * g.ny;
    const raw = async (name) => {
      const { raw: r, spec } = await ec.data(init, name, m);
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

  /** 上半部:各模式最新一報的摘要表(模式一列) */
  async summary(seq) {
    const rows = await Promise.all(this.models.map(async (m) => {
      const get = (v) => this.series(m, v).catch(() => null);
      const [rain, t2, wind, gust, swh] = await Promise.all(['rain6', 't2', 'wind', 'gust', 'swh'].map(get));
      const init = this.ec.idx(m).latest, steps = this.ec.stepsOf(m, init), days = steps[steps.length - 1] / 24;
      const total = rain && rain.ys.reduce((a, y) => a + (y ?? 0), 0);
      const cells = [
        `${fmtEcInit(init)}<small>${+days.toFixed(1)} 天</small>`,
        rain ? fmt(total, 0) : '—',
        t2 ? `${fmt(min(t2.ys))}–${fmt(max(t2.ys))}` : '—',
        wind ? `${fmt(max(wind.ys))}<small>${bfLabel(max(wind.ys))} 級</small>` : '—',
        gust ? fmt(max(gust.ys)) : '—',
        swh ? `${fmt(max(swh.ys))}${swh.coast ? '<small>外推</small>' : ''}` : '—',
      ];
      return `<tr><th><i style="background:${COLORS[m]}"></i>${MODELS[m].name}</th>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
    }));
    if (seq !== this.seq) return;
    this.el.querySelector('#fc-now').innerHTML = '<table><thead><tr><th>模式</th><th>起報</th><th>雨量 mm</th>'
      + '<th>溫度 °C</th><th>最大風 m/s</th><th>陣風</th><th>最大浪 m</th></tr></thead>'
      + `<tbody>${rows.join('')}</tbody></table>`
      + '<div class="sc-obs">各模式最新一報、整段預報期間：雨量 = 累積，溫度 = 最低–最高；「外推」= 近岸取最近的外海格點</div>';
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
    for (const { m, l, s } of got) {
      const ys = new Array(xs.length).fill(null);
      s.xs.forEach((x, k) => { ys[pos.get(x)] = s.ys[k]; });
      data.push(ys);
      const label = `${MODELS[m].name}${tab.lines.length > 1 ? ` ${l.label}` : ''}`;
      series.push({
        label, stroke: COLORS[m], width: 1.6, dash: l.dash ? [4, 3] : undefined, spanGaps: true,
        paths: l.v === 'rain6' ? uPlot.paths.stepped({ align: -1 }) : undefined,
        points: { show: false },
        value: (u, v) => (v == null ? '—' : this.tab === 'wind' ? `${v.toFixed(1)}（${bfLabel(v)}級）` : `${v.toFixed(1)} ${tab.unit}`),
      });
    }
    const coast = got.some((j) => j.s.coast);
    note.textContent = (this.tab === 'rain' ? '每 6 小時累積雨量（階梯線畫在那 6 小時）；' : '')
      + (this.tab === 'wind' ? '陣風只有 IFS（90 小時內前 1 小時最大、之後前 3 / 6 小時最大）；' : '')
      + (coast ? '近岸沒有值，取最近的外海格點（近岸外推）；' : '')
      + '青線 = 時間軸目前時間，白虛線 = 地圖顯示的預報時刻；點圖跳到那個時刻';

    const axisStyle = { stroke: '#9aa3b2', grid: { stroke: 'rgba(255,255,255,0.08)' }, ticks: { stroke: 'rgba(255,255,255,0.15)' } };
    const tick = (t) => { const s = fmtTW(stampOf(t), 'dh'); return s.endsWith('00時') ? s.replace('00時', '') : s.replace(/^\d+日/, ''); };
    const zero = this.tab === 'rain' || this.tab === 'swh';
    const cardT = () => this.T, ec = this.ec;
    this.plot = new uPlot({
      width: box.clientWidth || 400, height: 220, series,
      scales: { x: { time: true }, y: { auto: true, range: zero ? (u, lo, hi) => [0, Math.max(hi * 1.05, 1)] : undefined } },
      axes: [{ ...axisStyle, space: 45, values: (u, ticks) => ticks.map(tick) }, { ...axisStyle, label: tab.unit, size: 50 }],
      tzDate: (ts) => uPlot.tzDate(new Date(ts * 1e3), 'Asia/Taipei'),
      cursor: { drag: { x: false, y: false } },
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
    this.plot.over.style.cursor = 'pointer';
    this.plot.over.addEventListener('click', () => {
      const u = this.plot, i = u?.cursor.idx;
      if (i != null) this.onPick?.(u.data[0][i]);
    });
  }
}

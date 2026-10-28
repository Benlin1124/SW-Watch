// 測站資訊卡:點測站(或搜尋、排行榜)打開;顯示時間軸當下各變數,與折線圖(uPlot;1 小時到 10 天)
// 疊加預報:各模式最新一報在測站位置(最近格點)的預報線,虛線接在觀測後面(forecast_card.pointSeries)
// 時序資料:stations/recent/{縣市名 UTF-8 hex}.json.gz(pipeline/station_recent.py),一個縣市一個檔
import { getJSON } from './data.js';
import { bfLabel } from './colormaps.js';
import { fmtTW } from './time.js';
import { STATION_TYPES } from './layers/stations.js';
import * as prefs from './prefs.js';
import { FC_HOURS, mergeOverlay, overlayLines } from './forecast_card.js';

const REFETCH_MS = 5 * 60e3;
const HOURS = [1, 3, 6, 12, 24, 48, 72, 168, 240];
const hoursLabel = (h) => (h >= 168 ? `${h / 24} 天` : `${h} 小時`);
// 分頁 → 疊加的模式變數(溼度模式沒有);氣壓:測站氣壓 ↔ 模式海平面氣壓換算到測站海拔;雨量:平均每小時雨量畫在 1 小時雨量的軸
const FC_LINES = {
  temp: [{ v: 't2', label: '' }],
  pres: [{ v: 'pstn', label: '' }],
  wind: [{ v: 'wind', label: ' 平均風' }, { v: 'gust', label: ' 陣風', dash: [2, 3] }],
  rain: [{ v: 'rain1', label: ' 每小時', scale: 'r1h' }],
};
const toSec = (s) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12)) / 1000;
const countyKey = (c) => [...new TextEncoder().encode(c || '其他')].map((b) => b.toString(16).padStart(2, '0')).join('');
const fmt = (x, d = 1) => (x == null ? '—' : (+x).toFixed(d));
const windTxt = (x) => (x == null ? '—' : `${fmt(x)} m/s（${bfLabel(x)} 級）`);

// 圖表分頁:x = 'h'(整點)或 '10'(10 分鐘);series 依序畫
const TABS = {
  temp: { name: '溫度', x: 'h', series: [{ key: 'temp', label: '溫度', unit: '°C', stroke: '#ff7043' }] },
  rh: { name: '濕度', x: 'h', series: [{ key: 'rh', label: '相對濕度', unit: '%', stroke: '#42a5f5' }] },
  pres: { name: '氣壓', x: 'h', series: [{ key: 'pres', label: '氣壓', unit: 'hPa', stroke: '#ab47bc' }] },
  wind: { name: '風', x: 'h', series: [
    { key: 'ws', label: '風速', unit: 'm/s', stroke: '#26a69a', wind: true },
    { key: 'gust', label: '陣風', unit: 'm/s', stroke: '#ffca28', wind: true }] },
  rain: { name: '雨量', x: '10', series: [
    { key: 'rain_10m', label: '10 分鐘雨量', unit: 'mm', stroke: '#29b6f6', fill: 'rgba(41,182,246,0.7)', bars: true },
    { key: 'rain_1h', label: '1 小時雨量', unit: 'mm', stroke: '#1e88e5', scale: 'r1h' }] },
};
const VAR_TAB = { temp: 'temp', tmax: 'temp', tmin: 'temp', rh: 'rh', pres: 'pres', ws: 'wind', gust: 'wind' };

export class StationCard {
  el = document.getElementById('st-card');
  id = null;
  tab = 'temp';
  T = null;
  cache = new Map();         // 縣市 → { at, promise }
  plot = null;
  drawSeq = 0;
  hours = HOURS.includes(prefs.get('cardHours')) ? prefs.get('cardHours') : 72;   // 圖表時段
  range = null;              // 圖上的時間範圍 [起, 迄](UTC 秒)
  fcHours = FC_HOURS[prefs.get('cardFc')] ? prefs.get('cardFc') : 72;   // 疊加預報幾小時(0 = 不疊)

  constructor(layer, { onClose, ec } = {}) {
    this.layer = layer;
    this.onClose = onClose;
    this.ec = ec;              // 模式預報圖層(取各模式 index / 資料)
    this.el.querySelector('#sc-close').onclick = () => this.close();
    const hSel = this.el.querySelector('#sc-hours');
    hSel.innerHTML = HOURS.map((h) => `<option value="${h}">${hoursLabel(h)}</option>`).join('');
    hSel.value = this.hours;
    hSel.onchange = () => { this.hours = +hSel.value; prefs.set('cardHours', this.hours); this.drawChart(); };
    const fSel = this.el.querySelector('#sc-fc');
    fSel.innerHTML = Object.entries(FC_HOURS).map(([h, name]) => `<option value="${h}">${name}</option>`).join('');
    fSel.value = this.fcHours;
    fSel.onchange = () => { this.fcHours = +fSel.value; prefs.set('cardFc', this.fcHours); this.drawChart(); };
    for (const b of this.el.querySelectorAll('[data-tab]')) {
      b.onclick = () => { this.tab = b.dataset.tab; this.drawChart(); };
    }
  }

  series(county) {
    const c = this.cache.get(county);
    if (!c || Date.now() - c.at > REFETCH_MS) {
      const promise = getJSON(`stations/recent/${countyKey(county)}.json.gz`);
      promise.catch(() => this.cache.delete(county));
      this.cache.set(county, { at: Date.now(), promise });
    }
    return this.cache.get(county).promise;
  }

  async open(id, T) {
    const info = this.layer.all.get(id);
    if (!info) return;
    this.id = id;
    this.T = T;
    this.tab = VAR_TAB[this.layer.variable] ?? (this.layer.v.rain ? 'rain' : this.tab);
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
    this.onClose?.();
  }

  /** 時間軸移動:更新當下數值與圖上的時間線 */
  update(T) {
    if (!this.id) return;
    this.T = T;
    const info = this.layer.all.get(this.id);
    const alt = info.alt != null ? `　海拔 ${info.alt} m` : '';
    this.el.querySelector('#sc-title').textContent = `${info.name}（${info.id}）`;
    this.el.querySelector('#sc-sub').textContent = `${info.county}${info.town}　${STATION_TYPES[info.type] ?? ''}${alt}`;
    const snap = this.layer.snap, r = snap?.rows.get(this.id);
    const now = this.el.querySelector('#sc-now');
    if (!r || snap.time !== T) {
      now.innerHTML = `<div class="sc-nodata">${T ? fmtTW(T) : ''} 沒有這個站的資料</div>`;
    } else {
      const f = snap.f, g = (k) => (f[k] == null ? null : r[f[k]]);
      const dir = g('wd') == null ? '' : `，風向 ${Math.round(g('wd'))}°`;
      const items = [
        ['溫度', g('temp') == null ? '—' : `${fmt(g('temp'))} °C`], ['濕度', g('rh') == null ? '—' : `${fmt(g('rh'), 0)} %`],
        ['氣壓', g('pres') == null ? '—' : `${fmt(g('pres'))} hPa`], ['今日高／低', `${fmt(g('tmax'))}／${fmt(g('tmin'))} °C`],
        ['風速', windTxt(g('ws')) + dir], ['陣風', windTxt(g('gust'))],
        ['10 分鐘雨量', `${fmt(g('rain_10m'))} mm`], ['1 小時雨量', `${fmt(g('rain_1h'))} mm`],
        ['24 小時雨量', `${fmt(g('rain_24h'))} mm`], ['今日累積', `${fmt(g('rain_today'))} mm`],
      ];
      const obs = g('obs') ? `氣象要素觀測 ${fmtTW(g('obs'), 'hm')}，雨量 ${fmtTW(snap.time, 'hm')}` : '';
      now.innerHTML = items.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('')
        + `<div class="sc-obs">${obs}</div>`;
    }
    // 時間軸移到圖的範圍外(看過去的事件)→ 圖跟著移
    const t = T && toSec(T);
    if (this.plot && this.range && t && (t < this.range[0] || t > this.range[1])) this.drawChart();
    else this.plot?.redraw(false);
  }

  async drawChart() {
    const seq = ++this.drawSeq;
    for (const b of this.el.querySelectorAll('[data-tab]')) b.classList.toggle('on', b.dataset.tab === this.tab);
    const box = this.el.querySelector('#sc-chart'), note = this.el.querySelector('#sc-note');
    const id = this.id, info = this.layer.all.get(id);
    let d;
    try {
      d = await this.series(info.county);
    } catch {
      box.innerHTML = '<div class="sc-nodata">時序資料尚未產生</div>';
      return;
    }
    if (this.id !== id) return;
    const st = d.stations[id], tab = TABS[this.tab];
    this.plot?.destroy();
    this.plot = null;
    box.innerHTML = '';
    if (!st || tab.series.every((s) => !st[s.key]?.some((x) => x != null))) {
      box.innerHTML = `<div class="sc-nodata">這個站沒有${tab.name}資料</div>`;
      note.textContent = '';
      return;
    }
    // 日本氣象廳站的氣象要素也是 10 分鐘一筆(st.wx10)
    const hourly = tab.x === 'h' && !st.wx10;
    const ax = hourly ? d.th : d.t10, t0 = toSec(ax.start);
    const xsAll = Array.from({ length: ax.n }, (_, i) => t0 + i * ax.step * 60);
    // 時段:結尾 = 最新資料;時間軸在這段之前時,改成讓時間軸落在中間
    const H = this.hours * 3600, latest = toSec(d.time), T = this.T && toSec(this.T);
    const end = T && T <= latest - H ? Math.min(latest, T + H / 2) : latest;
    // 疊加預報:只在看最新時段時;圖往後延伸 fcHours
    const fcLines = end === latest && this.fcHours && this.ec ? FC_LINES[this.tab] ?? [] : [];
    const fcEnd = fcLines.length ? end + this.fcHours * 3600 : end;
    this.range = [end - H, fcEnd];
    const fc = fcLines.length ? await overlayLines(this.ec, fcLines, info.lon, info.lat, info.alt ?? 0) : [];
    if (this.id !== id || seq !== this.drawSeq) return;
    const keep = xsAll.map((x, i) => (x > end - H && x <= end ? i : -1)).filter((i) => i >= 0);
    const xs = keep.map((i) => xsAll[i]);
    const t10 = toSec(d.t10.start);
    const miss = [...d.have].filter((c, i) => c === '0' && t10 + i * 600 > end - H && t10 + i * 600 <= end).length;
    const endTxt = end === latest ? `至 ${fmtTW(d.time)}` : `${fmtTW(stampOf(end - H))}～${fmtTW(stampOf(end), 'hm')}`;
    const fcNote = !fcLines.length ? (end !== latest && this.fcHours ? '；看過去時段不疊預報' : this.fcHours && !FC_LINES[this.tab] ? '；模式沒有濕度' : '')
      : !fc.length ? '；這裡沒有模式預報'
        : `；虛線 = 模式預報（各模式最新一報、最近格點${this.tab === 'pres' ? '，海平面氣壓換算到測站海拔' : ''}${this.tab === 'rain' ? '，平均每小時雨量' : ''}${this.tab === 'temp' ? '，未做高度修正' : ''}）`;
    note.textContent = `${hoursLabel(this.hours)}（${endTxt}）`
      + (miss ? `；缺 ${miss} 筆 10 分鐘資料，圖上斷開處即缺漏` : '') + (hourly ? '；氣象要素為整點觀測' : '') + fcNote;

    const axisStyle = { stroke: '#9aa3b2', grid: { stroke: 'rgba(255,255,255,0.08)' }, ticks: { stroke: 'rgba(255,255,255,0.15)' } };
    const series = [{ label: '時間', value: (u, v) => (v == null ? '—' : fmtTW(stampOf(v))) }], data = [xs], scales = { x: { time: true } };
    // 刻度:台灣時間 0 時標「22日」,其他標「12時」
    // 6 小時以內的時段標「14:30」
    const tick = (t) => {
      if (this.hours <= 6) return fmtTW(stampOf(t), 'hm');
      const s = fmtTW(stampOf(t), 'dh');
      return s.endsWith('00時') ? s.replace('00時', '') : s.replace(/^\d+日/, '');
    };
    const axes = [{ ...axisStyle, space: 45, values: (u, ticks) => ticks.map(tick) }];
    for (const s of tab.series) {
      series.push({
        label: s.label, stroke: s.stroke, width: s.bars ? 0 : 1.6, fill: s.fill, scale: s.scale ?? 'y',
        paths: s.bars ? uPlot.paths.bars({ size: [0.9, 8] }) : undefined,
        points: { show: (tab.x === 'h' && this.hours <= 72) || this.hours <= 6, size: 4 },   // 7 天以上點太密不畫
        value: (u, v) => (v == null ? '—' : s.wind ? `${v.toFixed(1)}（${bfLabel(v)}級）` : `${v} ${s.unit}`),
      });
      data.push(keep.map((i) => st[s.key][i]));
      if (!scales[s.scale ?? 'y']) scales[s.scale ?? 'y'] = { auto: true, range: s.bars || s.scale === 'r1h' ? (u, lo, hi) => [0, Math.max(hi, 1)] : undefined };
    }
    const unit = tab.series[0].unit, wind = this.tab === 'wind';
    mergeOverlay(data, series, fc, end - H, fcEnd,
      (v, l) => (wind ? `${v.toFixed(1)}（${bfLabel(v)}級）` : `${v.toFixed(1)} ${l.scale ? 'mm/h' : unit}`));
    axes.push({ ...axisStyle, scale: 'y', label: `${tab.series[0].unit}`, size: 50 });
    if (scales.r1h) axes.push({ ...axisStyle, scale: 'r1h', side: 1, label: '1 小時 mm', grid: { show: false }, size: 50 });

    const cardT = () => this.T;
    this.plot = new uPlot({
      width: box.clientWidth || 400, height: 220, series, scales, axes,
      tzDate: (ts) => uPlot.tzDate(new Date(ts * 1e3), 'Asia/Taipei'),   // 刻度對齊台灣整點
      cursor: { drag: { x: false, y: false } },
      legend: { live: true },
      hooks: {
        draw: [(u) => {                                   // 時間軸目前時間 = 直線
          const T = cardT();
          if (!T) return;
          const x = u.valToPos(toSec(T), 'x', true);
          if (x < u.bbox.left || x > u.bbox.left + u.bbox.width) return;
          const c = u.ctx;
          c.save();
          c.strokeStyle = '#00e5ff';
          c.lineWidth = 1.5 * devicePixelRatio;
          c.beginPath(); c.moveTo(x, u.bbox.top); c.lineTo(x, u.bbox.top + u.bbox.height); c.stroke();
          c.restore();
        }],
      },
    }, data, box);
  }
}

/** UTC 秒 → stamp(給 fmtTW) */
function stampOf(sec) {
  const d = new Date(sec * 1000), p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

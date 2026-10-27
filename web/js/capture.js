// 地圖擷取(設計log「地圖擷取功能」):
// 按「📷 擷取」→ 地圖上出現擷取框,移動 / 縮放地圖調整框內範圍;選尺寸(預設比例或自訂寬×高、鎖定比例、1× / 2×)
// 與要加入的項目(標題、資料時間、色階、資料來源、比例尺、經緯網格)。
// 輸出:用目標尺寸在隱藏容器重新渲染 MapLibre(框的 CSS 大小 + pixelRatio = 輸出寬 / 框寬,範圍和框內完全一樣、大圖也清楚),
// 再把 HTML 標示(測站數值、颱風標示)、色階和文字畫到同一張 canvas,存成 PNG。
import { arrowImage } from './layers/stations.js';
import * as prefs from './prefs.js';

const SIZES = {
  '16:9': [1920, 1080], '4:3': [1600, 1200], '1:1': [1080, 1080], '9:16': [1080, 1920],
  A4L: [3508, 2480], A4P: [2480, 3508],
};
const OPTS = ['title', 'time', 'legend', 'source', 'scale', 'grid'];
const DEFAULT = { size: '16:9', w: 1920, h: 1080, lock: true, mult: 1, title: true, time: true, legend: true, source: true, scale: true, grid: false };
const MARGIN = 16;
const SOURCE_TEXT = '資料：中央氣象署、NCDR、ECMWF (CC BY 4.0)、NOAA NCEP、Google DeepMind WeatherLab、Natural Earth';

const $ = (id) => document.getElementById(id);

export class Capture {
  constructor(map, toast) {
    this.map = map;
    this.toast = toast;
    this.cfg = { ...DEFAULT, ...prefs.get('capture') };
    this.open = false;
    this.bind();
  }

  bind() {
    const c = this.cfg;
    $('shot-size').value = c.size;
    $('shot-w').value = c.w;
    $('shot-h').value = c.h;
    $('shot-lock').checked = c.lock;
    $('shot-mult').value = String(c.mult);
    for (const k of OPTS) $(`shot-${k}`).checked = c[k];

    $('btn-shot').onclick = () => this.toggle(!this.open);
    $('shot-cancel').onclick = () => this.toggle(false);
    $('shot-go').onclick = () => this.save();
    $('shot-size').onchange = (e) => {
      c.size = e.target.value;
      if (SIZES[c.size]) [c.w, c.h] = SIZES[c.size];
      this.syncSize();
    };
    const edit = (key) => (e) => {
      const v = Math.max(100, Math.min(10000, Math.round(+e.target.value) || 0));
      const ratio = c.w / c.h;
      c[key] = v;
      if (c.lock) {
        if (key === 'w') c.h = Math.round(v / ratio); else c.w = Math.round(v * ratio);
      }
      c.size = Object.keys(SIZES).find((s) => SIZES[s][0] === c.w && SIZES[s][1] === c.h) ?? 'custom';
      this.syncSize();
    };
    $('shot-w').onchange = edit('w');
    $('shot-h').onchange = edit('h');
    $('shot-lock').onchange = (e) => { c.lock = e.target.checked; this.store(); };
    $('shot-mult').onchange = (e) => { c.mult = +e.target.value; this.syncSize(); };
    for (const k of OPTS) $(`shot-${k}`).onchange = (e) => { c[k] = e.target.checked; this.store(); };
    window.addEventListener('resize', () => this.open && this.place());
    document.addEventListener('keydown', (e) => { if (this.open && e.key === 'Escape') this.toggle(false); });
  }

  store() { prefs.set('capture', this.cfg); }

  syncSize() {
    const c = this.cfg;
    $('shot-size').value = c.size;
    $('shot-w').value = c.w;
    $('shot-h').value = c.h;
    $('shot-info').textContent = `輸出 ${c.w * c.mult} × ${c.h * c.mult} px`;
    this.store();
    if (this.open) this.place();
  }

  toggle(on) {
    this.open = on;
    $('shot-ui').hidden = !on;
    $('shot-frame').hidden = !on;
    $('btn-shot').classList.toggle('on', on);
    if (on) this.syncSize();
  }

  /** 擷取框:目標比例,放在圖層選單右邊、擷取設定下方、時間軸上方的可用範圍正中間 */
  place() {
    const panel = $('panel'), ui = $('shot-ui'), tl = $('timeline');
    const pr = panel.getBoundingClientRect();
    const left = (panel.classList.contains('collapsed') || !pr.width ? 0 : pr.right) + MARGIN;
    const top = ui.getBoundingClientRect().bottom + MARGIN;
    const tr = tl.getBoundingClientRect();
    const bottom = (tr.height ? tr.top : innerHeight) - MARGIN;
    const right = innerWidth - MARGIN;
    const aw = Math.max(50, right - left), ah = Math.max(50, bottom - top);
    const ratio = this.cfg.w / this.cfg.h;
    const w = Math.min(aw, ah * ratio), h = w / ratio;
    Object.assign($('shot-frame').style, {
      left: `${left + (aw - w) / 2}px`, top: `${top + (ah - h) / 2}px`, width: `${w}px`, height: `${h}px`,
    });
  }

  async save() {
    const btn = $('shot-go');
    btn.disabled = true;
    this.toast('擷取中…');
    try {
      const canvas = await this.render();
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
      const a = document.createElement('a');
      a.download = `SW-Watch_${this.fileTime()}_${canvas.width}x${canvas.height}.png`;
      a.href = URL.createObjectURL(blob);
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      this.toast(this.warn ?? '已存成圖片', this.warn ? 4000 : 1500);
    } catch (e) {
      console.error('擷取失敗', e);
      this.toast(`擷取失敗:${e.message}`, 4000);
    } finally {
      btn.disabled = false;
    }
  }

  fileTime() {
    const m = $('clock-main').textContent.match(/(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})/);
    return m ? m.slice(1).join('') : 'latest';
  }

  async render() {
    const c = this.cfg, map = this.map;
    const W = c.w * c.mult, H = c.h * c.mult;
    this.outW = W;
    const fr = $('shot-frame').getBoundingClientRect();
    const mr = map.getContainer().getBoundingClientRect();
    const k = W / fr.width;                                   // 輸出 px / 螢幕 CSS px
    const center = map.unproject([fr.left - mr.left + fr.width / 2, fr.top - mr.top + fr.height / 2]);
    this.warn = null;

    // 1. 地圖:同樣的樣式、中心、縮放,在和框一樣大的隱藏容器以 pixelRatio = k 重畫
    const style = map.getStyle();
    for (const l of style.layers) {
      if (l.id === 'grid-major' || l.id === 'grid-minor') l.layout = { ...l.layout, visibility: c.grid ? 'visible' : 'none' };
    }
    const box = document.createElement('div');
    box.style.cssText = `position:fixed;left:-20000px;top:0;width:${fr.width}px;height:${fr.height}px;`;
    document.body.appendChild(box);
    const m2 = new maplibregl.Map({
      container: box, style, center, zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch(),
      pixelRatio: k, interactive: false, attributionControl: false, fadeDuration: 0,
      preserveDrawingBuffer: true, maxCanvasSize: [16384, 16384],
    });
    m2.on('styleimagemissing', (e) => {
      if (e.id === 'st-arrow' && !m2.hasImage('st-arrow')) m2.addImage('st-arrow', arrowImage(), { sdf: true });
    });
    const out = document.createElement('canvas');
    out.width = W; out.height = H;
    const ctx = out.getContext('2d');
    try {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('地圖重畫逾時')), 60000);
        m2.once('idle', () => { clearTimeout(t); resolve(); });
      });
      const cv = m2.getCanvas();
      if (cv.width < W * 0.98) this.warn = `尺寸超過瀏覽器繪圖上限,地圖以 ${cv.width}×${cv.height} 繪製後放大`;
      ctx.drawImage(cv, 0, 0, W, H);
    } finally {
      m2.remove();
      box.remove();
    }

    // 1b. 風場 / 海浪動畫:擷取當下畫面上的粒子(螢幕解析度,放大到輸出尺寸)
    for (const wc of map.getContainer().querySelectorAll('.wind-canvas')) {
      if (wc.style.display === 'none') continue;
      const r = wc.width / mr.width;
      ctx.drawImage(wc, (fr.left - mr.left) * r, (fr.top - mr.top) * r, fr.width * r, fr.height * r, 0, 0, W, H);
    }

    // 2. HTML 標示(測站數值、颱風名稱與時間):照螢幕上相對擷取框的位置畫,大小乘 k
    for (const el of map.getContainer().querySelectorAll('.maplibregl-marker')) {
      const r = el.getBoundingClientRect();
      if (!el.textContent || r.right < fr.left || r.left > fr.right || r.bottom < fr.top || r.top > fr.bottom) continue;
      const cs = getComputedStyle(el);
      ctx.save();
      ctx.globalAlpha = +cs.opacity || 1;
      ctx.font = `${cs.fontWeight} ${parseFloat(cs.fontSize) * k}px ${cs.fontFamily}`;
      ctx.textBaseline = 'middle';
      const x = (r.left - fr.left) * k, y = (r.top - fr.top + r.height / 2) * k;
      const halo = cs.textShadow.match(/rgba?\([^)]*\)/)?.[0];
      if (halo) {
        ctx.strokeStyle = halo; ctx.lineWidth = 3 * k; ctx.lineJoin = 'round';
        ctx.strokeText(el.textContent, x, y);
      }
      ctx.fillStyle = cs.color;
      ctx.fillText(el.textContent, x, y);
      ctx.restore();
    }

    // 3. 疊加項目:大小跟著 k(和螢幕上看到的比例一致),但不超過圖寬的一定比例
    const pad = 12 * k;
    if (c.title || c.time) this.drawTitle(ctx, k, pad, W);
    // 資料來源在最下面一列,比例尺(左)和色階(右)放在它上面
    const bottom = c.source ? this.drawSource(ctx, k, pad, H - pad, W) : H - pad;
    const scaleW = c.scale ? this.drawScale(ctx, k, pad, bottom, center.lat, map.getZoom()) + 8 * k : 0;
    if (c.legend) await this.drawLegend(ctx, k, pad, W - scaleW, bottom);
    return out;
  }

  drawBox(ctx, x, y, w, h, k) {
    ctx.save();
    ctx.fillStyle = 'rgba(18, 22, 30, 0.85)';
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 4 * k);
    ctx.fill();
    ctx.restore();
  }

  drawTitle(ctx, k, pad, W) {
    const c = this.cfg, lines = [];
    if (c.title) lines.push({ text: 'SW-Watch 劇烈天氣監控', size: 18, weight: 700, color: '#fff' });
    if (c.time) {
      lines.push({ text: $('clock-main').textContent, size: 14, weight: 700, color: '#fff' });
      const utc = $('clock-utc').textContent;
      if (utc) lines.push({ text: utc, size: 11, weight: 400, color: '#aab' });
      // 各圖層實際資料時間(不一定剛好是時間軸那一格)
      for (const layer of document.querySelectorAll('#panel .layer')) {
        if (!layer.querySelector('.layer-head input')?.checked) continue;
        const name = layer.querySelector('.layer-name')?.textContent.trim();
        const t = layer.querySelector('.layer-time')?.textContent.trim();
        if (name && t && t !== '--') lines.push({ text: `${name}　${t}`, size: 11, weight: 400, color: '#ccd' });
      }
    }
    const s = Math.min(k, (W * 0.45) / 260);
    const font = (l) => `${l.weight} ${l.size * s}px system-ui, "Microsoft JhengHei", sans-serif`;
    let w = 0, h = 0;
    for (const l of lines) {
      ctx.font = font(l);
      w = Math.max(w, ctx.measureText(l.text).width);
      h += l.size * 1.45 * s;
    }
    const ip = 8 * s;
    this.drawBox(ctx, pad, pad, w + ip * 2, h + ip * 2 - 4 * s, s);
    let y = pad + ip;
    ctx.textBaseline = 'top';
    for (const l of lines) {
      ctx.font = font(l);
      ctx.fillStyle = l.color;
      ctx.fillText(l.text, pad + ip, y);
      y += l.size * 1.45 * s;
    }
  }

  /** 左下資料來源;回傳下一個項目可用的底線 y */
  drawSource(ctx, k, pad, bottom, W) {
    ctx.font = '11px system-ui, "Microsoft JhengHei", sans-serif';
    const s = Math.min(k, (W - pad * 2 - 12) / ctx.measureText(SOURCE_TEXT).width);   // 整列放得下
    ctx.font = `${11 * s}px system-ui, "Microsoft JhengHei", sans-serif`;
    const w = ctx.measureText(SOURCE_TEXT).width, h = 18 * s, ip = 6 * s;
    this.drawBox(ctx, pad, bottom - h, w + ip * 2, h, s);
    ctx.fillStyle = '#dde';
    ctx.textBaseline = 'middle';
    ctx.fillText(SOURCE_TEXT, pad + ip, bottom - h / 2);
    return bottom - h - 6 * s;
  }

  /** 比例尺:框中心緯度,螢幕上約 100 px 的整數距離(1、2、5 × 10ⁿ km);回傳占用寬度 */
  drawScale(ctx, k, pad, bottom, lat, zoom) {
    const mPerPx = (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** zoom);
    const maxKm = (100 * mPerPx) / 1000;
    const p = 10 ** Math.floor(Math.log10(maxKm));
    const km = [5, 2, 1].map((f) => f * p).find((v) => v <= maxKm) ?? p;
    const len = ((km * 1000) / mPerPx) * k, ip = 6 * k, h = 26 * k;
    const label = km >= 1 ? `${km} km` : `${km * 1000} m`;
    this.drawBox(ctx, pad, bottom - h, len + ip * 2, h, k);
    const x0 = pad + ip, y = bottom - 7 * k;
    ctx.save();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 * k;
    ctx.beginPath();
    ctx.moveTo(x0, y - 5 * k); ctx.lineTo(x0, y); ctx.lineTo(x0 + len, y); ctx.lineTo(x0 + len, y - 5 * k);
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = `${11 * k}px system-ui, sans-serif`;
    ctx.textBaseline = 'bottom';
    ctx.fillText(label, x0 + 2 * k, y - 4 * k);
    ctx.restore();
    return pad + len + ip * 2;
  }

  /** 色階:把網頁上的色階 HTML 轉圖放右下(暫時取消收合與縮放);寬度不超過 W(已扣掉左邊比例尺) */
  async drawLegend(ctx, k, pad, W, bottom) {
    const legend = $('legend'), body = $('legend-body');
    if (legend.style.display === 'none' || !body.children.length) return;
    const { toCanvas } = await import('https://cdn.jsdelivr.net/npm/html-to-image@1.11.11/+esm');
    const folded = legend.classList.contains('folded'), zoom = body.style.zoom;
    legend.classList.remove('folded');
    body.style.zoom = 1;
    try {
      const bw = body.scrollWidth, bh = body.scrollHeight;
      // 比螢幕上小一點(0.7),寬不超過圖寬 35%(直式 60%)、高不超過 30%;網頁上色階的 −/＋ 也會跟著放大縮小
      const frac = this.outW >= bottom ? 0.35 : 0.6;
      const s = Math.min(k * (+zoom || 1) * 0.7, Math.min(W - pad * 2 - 16 * k, this.outW * frac) / bw, (bottom * 0.3) / bh);
      const img = await toCanvas(body, { pixelRatio: s, skipFonts: true, width: bw, height: bh,
        filter: (n) => !n.classList?.contains('info') });          // ⓘ 說明不畫進圖
      const ip = 8 * s, w = bw * s, h = bh * s;
      const x = this.outW - pad - w - ip * 2, y = bottom - h - ip * 2;
      this.drawBox(ctx, x, y, w + ip * 2, h + ip * 2, s);
      ctx.drawImage(img, x + ip, y + ip, w, h);
    } finally {
      legend.classList.toggle('folded', folded);
      body.style.zoom = zoom;
    }
  }
}

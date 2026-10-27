// 風場動畫(設計log「風場動畫」):ECMWF 10 m 風(u10、v10)驅動的流動粒子,疊在所有圖層上
// 不用新資料:直接讀 ECMWF 圖層的檔。時間:ECMWF 圖層開著 → 跟它顯示的時刻;沒開 → 跟時間軸 T,
// 取 T 之前最近一報、在前後兩個預報時刻(每 3 小時)之間線性內插,播放時風場平順變化。
// 粒子用螢幕座標的速度移動(和縮放無關),畫在地圖上方一張 canvas(不接滑鼠事件),尾跡逐格淡出。
import { beaufort, beaufortLegendHTML, SCALES } from '../colormaps.js';
import { addMin, diffMin, fmtTW, nowStamp } from '../time.js';
import { fmtEcInit } from './ecmwf.js';

const SPEED = 0.08;          // 每格移動像素 / (m/s):10 m/s ≈ 0.8 px/格(60 格/秒)
const FADE = 0.93;           // 每格尾跡保留比例(越大尾巴越長)
const AREA_PER = 350;        // 每多少平方像素一個粒子(密度 1 倍)
const MAX_N = 6000;
const AGE = [40, 110];       // 粒子壽命(格),到期換位置重生
const SLICES_MAX = 8;
const COLORS = { white: 'rgba(255,255,255,0.9)', black: 'rgba(25,25,25,0.85)' };
const DIRS = ['北', '北北東', '東北', '東北東', '東', '東南東', '東南', '南南東', '南', '南南西', '西南', '西南西', '西', '西北西', '西北', '北北西'];

export class WindLayer {
  key = 'wind';
  visible = false;
  color = 'white';           // white / black / speed(依蒲福風級上色)
  density = 1;
  u = null; v = null;        // 目前顯示的場(已內插)
  shown = null;              // { key, init, hours }
  slices = new Map();        // `${init}/${k}` → Promise<{u, v}>
  particles = [];

  constructor(map, ecmwf) {
    this.map = map;
    this.ec = ecmwf;
  }

  get index() { return this.ec.index; }

  addTo() {
    const m = this.map, cv = document.createElement('canvas');
    cv.className = 'wind-canvas';
    m.getCanvas().after(cv);          // 地圖之上、HTML 標示(測站數值、颱風名)之下
    this.canvas = cv;
    this.ctx = cv.getContext('2d');
    this.resize();
    m.on('resize', () => { this.resize(); this.reseed(); });
    m.on('move', () => this.reproject());
    m.on('moveend', () => this.reseed());
  }

  resize() {
    const c = this.map.getContainer(), r = devicePixelRatio || 1;
    this.W = c.clientWidth; this.H = c.clientHeight;
    this.canvas.width = this.W * r; this.canvas.height = this.H * r;
    this.canvas.style.width = `${this.W}px`; this.canvas.style.height = `${this.H}px`;
    this.ctx.setTransform(r, 0, 0, r, 0, 0);
  }

  setVisible(v) {
    this.visible = v;
    this.canvas.style.display = v ? '' : 'none';
    if (v) { this.reseed(); this.start(); } else { this.stop(); this.clear(); }
  }

  setColor(c) { this.color = c; this.clear(); }
  setDensity(d) { this.density = d; this.reseed(); }

  // ── 時間 ──
  /** 要顯示的起報與預報小時;ECMWF 開著就跟它,否則跟時間軸(不同步時用現在) */
  target(T) {
    const ec = this.ec, steps = ec.steps;
    if (!ec.index || !steps.length) return null;
    if (ec.visible && ec.shown) return { init: ec.shown.init, hours: ec.shown.step };
    T = T ?? nowStamp();
    const inits = ec.inits;                                    // 新 → 舊
    const init = inits.find((i) => i <= T) ?? inits[inits.length - 1];
    if (!init) return null;
    const h = Math.min(Math.max(diffMin(T, init) / 60, steps[0]), steps[steps.length - 1]);
    return { init, hours: h };
  }

  slice(init, k) {
    const key = `${init}/${k}`;
    if (!this.slices.has(key)) {
      const p = Promise.all([this.ec.slice(init, 'u10', k), this.ec.slice(init, 'v10', k)]).then(([u, v]) => ({ u, v }));
      p.catch(() => this.slices.delete(key));
      this.slices.set(key, p);
      while (this.slices.size > SLICES_MAX) this.slices.delete(this.slices.keys().next().value);
    }
    return this.slices.get(key);
  }

  async update(T) {
    if (!this.visible) return;
    const t = this.target(T);
    if (!t) { this.u = this.v = null; this.shown = null; return; }
    const key = `${t.init}|${t.hours}`;
    if (this.shown?.key === key) return;
    this.wanted = key;
    const steps = this.ec.steps;
    let k1 = steps.findIndex((s) => s >= t.hours);
    if (k1 < 0) k1 = steps.length - 1;
    const k0 = steps[k1] === t.hours ? k1 : Math.max(k1 - 1, 0);
    const w = k0 === k1 ? 0 : (t.hours - steps[k0]) / (steps[k1] - steps[k0]);
    const [a, b] = await Promise.all([this.slice(t.init, k0), this.slice(t.init, k1)]);
    if (this.wanted !== key) return;
    const n = a.u.length, u = new Float32Array(n), v = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      u[i] = a.u[i] * (1 - w) + b.u[i] * w;
      v[i] = a.v[i] * (1 - w) + b.v[i] * w;
    }
    this.u = u; this.v = v;
    this.shown = { key, init: t.init, hours: t.hours, exact: w === 0 };
    if (!this.particles.length) this.reseed();
  }

  timeLabel() {
    if (!this.shown) return null;
    const { init, hours, exact } = this.shown, h = Math.round(hours * 10) / 10;
    return { text: `${fmtTW(addMin(init, Math.round(hours * 60)))}（${fmtEcInit(init)} +${h}h${exact ? '' : ' 內插'}）` };
  }

  // ── 取值 ──
  /** 經緯度上的 [u, v](雙線性內插);格外或無資料 → null */
  sample(lon, lat) {
    const g = this.ec.index?.grid;
    if (!this.u || !g) return null;
    const fx = (lon - g.lon0) / g.dx, fy = (lat - g.lat0) / g.dy;
    if (fx < 0 || fy < 0 || fx > g.nx - 1 || fy > g.ny - 1) return null;
    const x0 = Math.min(Math.floor(fx), g.nx - 2), y0 = Math.min(Math.floor(fy), g.ny - 2), tx = fx - x0, ty = fy - y0;
    const i = y0 * g.nx + x0, j = i + g.nx;
    const bl = (f) => (f[i] * (1 - tx) + f[i + 1] * tx) * (1 - ty) + (f[j] * (1 - tx) + f[j + 1] * tx) * ty;
    const u = bl(this.u), v = bl(this.v);
    return Number.isNaN(u) || Number.isNaN(v) ? null : [u, v];
  }

  valueAt(lng, lat) {
    if (!this.visible) return null;
    const w = this.sample(lng, lat);
    if (!w) return null;
    const [u, v] = w, from = ((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360;   // 風的來向
    return `風場 ${DIRS[Math.round(from / 22.5) % 16]}風 ${Math.hypot(u, v).toFixed(1)} m/s`;
  }

  // ── 粒子 ──
  /** 畫面與 ECMWF 範圍交集(螢幕座標);沒有交集 → null */
  box() {
    const g = this.ec.index?.grid;
    if (!g) return null;
    const m = this.map, a = m.project([g.lon0, g.lat0 + (g.ny - 1) * g.dy]), b = m.project([g.lon0 + (g.nx - 1) * g.dx, g.lat0]);
    const x0 = Math.max(Math.min(a.x, b.x), 0), x1 = Math.min(Math.max(a.x, b.x), this.W);
    const y0 = Math.max(Math.min(a.y, b.y), 0), y1 = Math.min(Math.max(a.y, b.y), this.H);
    return x1 - x0 > 2 && y1 - y0 > 2 ? { x0, y0, x1, y1 } : null;
  }

  spawn(p, box) {
    p.x = box.x0 + Math.random() * (box.x1 - box.x0);
    p.y = box.y0 + Math.random() * (box.y1 - box.y0);
    const ll = this.map.unproject([p.x, p.y]);
    p.lon = ll.lng; p.lat = ll.lat;
    p.age = 0;
    p.max = AGE[0] + Math.random() * (AGE[1] - AGE[0]);
    return p;
  }

  reseed() {
    if (!this.visible) return;
    this.clear();
    this.box_ = this.box();
    const b = this.box_;
    if (!b) { this.particles = []; return; }
    const n = Math.min(Math.round(((b.x1 - b.x0) * (b.y1 - b.y0) / AREA_PER) * this.density), MAX_N);
    this.particles = Array.from({ length: n }, () => {
      const p = this.spawn({}, b);
      p.age = Math.random() * p.max;          // 錯開壽命,才不會同時重生
      return p;
    });
  }

  /** 拖動 / 縮放中:清掉尾跡,粒子留在原經緯度、重算螢幕位置 */
  reproject() {
    if (!this.visible) return;
    this.clear();
    for (const p of this.particles) {
      const q = this.map.project([p.lon, p.lat]);
      p.x = q.x; p.y = q.y;
    }
  }

  clear() { this.ctx?.clearRect(0, 0, this.W, this.H); }

  start() {
    if (this.raf) return;
    const loop = () => { this.raf = requestAnimationFrame(loop); this.step(); };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = null;
  }

  step() {
    const ctx = this.ctx, m = this.map, b = this.box_;
    ctx.globalCompositeOperation = 'destination-in';           // 舊尾跡變淡(透明),底圖不受影響
    ctx.fillStyle = `rgba(0,0,0,${FADE})`;
    ctx.fillRect(0, 0, this.W, this.H);
    ctx.globalCompositeOperation = 'source-over';
    if (!this.u || !b || m.isMoving()) return;
    const ppd = (512 * 2 ** m.getZoom()) / 360, k = SPEED;    // ppd:赤道上每度經度幾像素
    const bySpeed = this.color === 'speed', paths = new Map();
    for (const p of this.particles) {
      const w = ++p.age > p.max ? null : this.sample(p.lon, p.lat);
      if (!w) { this.spawn(p, b); continue; }
      const [u, v] = w, lon = p.lon + (u * k) / ppd, lat = p.lat + (v * k * Math.cos((p.lat * Math.PI) / 180)) / ppd;
      const q = m.project([lon, lat]);
      if (q.x < b.x0 || q.x > b.x1 || q.y < b.y0 || q.y > b.y1) { this.spawn(p, b); continue; }
      const c = bySpeed ? beaufort(Math.hypot(u, v)) : 0;
      if (!paths.has(c)) paths.set(c, new Path2D());
      const path = paths.get(c);
      path.moveTo(p.x, p.y);
      path.lineTo(q.x, q.y);
      p.x = q.x; p.y = q.y; p.lon = lon; p.lat = lat;
    }
    ctx.lineWidth = 1.3;
    ctx.lineCap = 'round';
    for (const [c, path] of paths) {
      ctx.strokeStyle = bySpeed ? SCALES.wind.colors[Math.min(c, SCALES.wind.colors.length - 1)] : COLORS[this.color];
      ctx.stroke(path);
    }
  }

  legend() {
    const s = this.shown, when = s ? `（${fmtEcInit(s.init)} +${Math.round(s.hours * 10) / 10}h）` : '（無資料）';
    const title = `風場動畫：ECMWF 10 m 風預報${when}`;
    return this.color === 'speed' ? beaufortLegendHTML(`${title} 粒子顏色（蒲福風級）`, SCALES.wind.colors) : `<div class="legend-title">${title}</div>`;
  }
}

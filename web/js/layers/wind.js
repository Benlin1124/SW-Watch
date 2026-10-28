// 風場 / 海浪動畫(設計log「風場動畫」「海浪動畫」):ECMWF 預報驅動的流動粒子,疊在所有圖層上
// 不用新資料:直接讀 ECMWF 圖層的檔。時間:ECMWF 圖層開著 → 跟它顯示的時刻;沒開 → 跟時間軸 T,
// 取 T 之前最近一報、在前後兩個預報時刻(每 3 小時)之間線性內插,播放時平順變化。
// 每種一張 canvas,在地圖之上、不接滑鼠事件。粒子用螢幕座標的速度移動(和縮放無關)。
//   風(kind wind):10 m 風 u10 / v10,粒子留尾跡、逐格淡出。
//   浪(kind wave):浪前進方向(mwd 來向轉 180°),畫成往前凸的波峰弧線,不留尾跡、淡入淡出;
//     弧長隨浪高(swh)、速度隨尖峰週期(pp1d,深水波速和週期成正比)。近岸用 ECMWF 圖層外推的值,
//     碰到底圖陸地(land.js)才消失 → 浪峰一路走到海岸線。
import { beaufort, beaufortLegendHTML, infoHTML, legendHTML, SCALES, withInfo } from '../colormaps.js';
import { addMin, diffMin, fmtTW, nowStamp } from '../time.js';
import { fmtEcInit } from './ecmwf.js';
import { waveClass } from './marine.js';

const KINDS = {
  wind: {
    vars: ['u10', 'v10'],
    speed: 0.08,             // 每格移動像素 / (m/s):10 m/s ≈ 0.8 px/格(60 格/秒)
    areaPer: 350,            // 每多少平方像素一個粒子(密度 1 倍)
    age: [40, 110],          // 粒子壽命(格),到期換位置重生
  },
  wave: {
    vars: ['swh', 'mwd', 'pp1d'],
    speed: 0.1,              // 每格移動像素 / 秒週期:10 s ≈ 1 px/格
    areaPer: 1100,
    age: [60, 150],
  },
};
const FADE = 0.93;           // 風:每格尾跡保留比例(越大尾巴越長)
const MAX_N = 6000;
const SLICES_MAX = 8;
const COLORS = { white: 'rgba(255,255,255,0.9)', black: 'rgba(25,25,25,0.85)' };
const ALPHAS = [0.25, 0.5, 0.75, 1];          // 浪:淡入淡出分 4 級(同級一起畫)
const TIME_NOTE = 'ECMWF 圖層開著時跟它的預報時刻；沒開時跟時間軸，在前後兩個預報時刻（每 3 小時）之間內插。這是預報，不是觀測。';
const DIRS = ['北', '北北東', '東北', '東北東', '東', '東南東', '東南', '南南東', '南', '南南西', '西南', '西南西', '西', '西北西', '西北', '北北西'];
const dirName = (x, y) => DIRS[Math.round((((Math.atan2(x, y) * 180) / Math.PI + 360) % 360) / 22.5) % 16];
const levelOf = (levels, x) => { let i = 0; while (i + 1 < levels.length && x >= levels[i + 1]) i++; return i; };

export class WindLayer {
  visible = false;
  color = 'white';           // white / black / speed(風:依蒲福風級;浪:依浪高)
  density = 1;
  f = null;                  // 目前顯示的場(已內插):風 { u, v };浪 { x, y, t, h }(x、y = 浪前進方向單位向量)
  shown = null;              // { key, init, hours, exact }
  slices = new Map();        // `${init}/${k}` → Promise<場>
  particles = [];

  constructor(map, ecmwf, kind = 'wind') {
    this.map = map;
    this.ec = ecmwf;
    this.kind = kind;
    this.key = kind;
    this.K = KINDS[kind];
  }

  get index() { return this.ec.index; }

  addTo() {
    const m = this.map, cv = document.createElement('canvas');
    cv.className = 'wind-canvas';
    cv.style.display = 'none';
    m.getCanvas().after(cv);          // 地圖之上、HTML 標示(測站數值、颱風名)之下;後加的在下面
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

  /** 第 k 步的場;浪的方向先轉成單位向量,內插才不會在 0° / 360° 出錯 */
  slice(init, k) {
    const key = `${init}/${k}`;
    if (!this.slices.has(key)) {
      const p = Promise.all(this.K.vars.map((v) => this.ec.slice(init, v, k))).then(([a, b, c]) => {
        if (this.kind === 'wind') return { u: a, v: b };
        const rad = b.map((d) => ((d + 180) * Math.PI) / 180);
        return { x: rad.map(Math.sin), y: rad.map(Math.cos), t: c, h: a };
      });
      p.catch(() => this.slices.delete(key));
      this.slices.set(key, p);
      while (this.slices.size > SLICES_MAX) this.slices.delete(this.slices.keys().next().value);
    }
    return this.slices.get(key);
  }

  async update(T) {
    if (!this.visible) return;
    const t = this.target(T);
    if (!t) { this.f = null; this.shown = null; return; }
    const key = `${t.init}|${t.hours}`;
    if (this.shown?.key === key) return;
    this.wanted = key;
    const steps = this.ec.steps;
    let k1 = steps.findIndex((s) => s >= t.hours);
    if (k1 < 0) k1 = steps.length - 1;
    const k0 = steps[k1] === t.hours ? k1 : Math.max(k1 - 1, 0);
    const w = k0 === k1 ? 0 : (t.hours - steps[k0]) / (steps[k1] - steps[k0]);
    let a, b;
    try {
      [a, b] = await Promise.all([this.slice(t.init, k0), this.slice(t.init, k1)]);
    } catch (e) {
      if (this.wanted === key) { this.f = null; this.shown = null; }   // 舊報沒有這個變數(例如海浪加入前)
      throw e;
    }
    if (this.wanted !== key) return;
    const f = {};
    for (const [name, x0] of Object.entries(a)) {
      const x1 = b[name], out = new Float32Array(x0.length);
      for (let i = 0; i < x0.length; i++) out[i] = x0[i] * (1 - w) + x1[i] * w;
      f[name] = out;
    }
    this.f = f;
    this.shown = { key, init: t.init, hours: t.hours, exact: w === 0 };
    if (!this.particles.length) this.reseed();
  }

  timeLabel() {
    if (!this.shown) return null;
    const { init, hours, exact } = this.shown, h = Math.round(hours * 10) / 10;
    return { text: `${fmtTW(addMin(init, Math.round(hours * 60)))}（${fmtEcInit(init)} +${h}h${exact ? '' : ' 內插'}）` };
  }

  // ── 取值 ──
  /** 經緯度上各欄的值(雙線性內插);格外或任一角無資料(浪的陸地)→ null */
  sample(lon, lat) {
    const g = this.ec.index?.grid, f = this.f;
    if (!f || !g) return null;
    const fx = (lon - g.lon0) / g.dx, fy = (lat - g.lat0) / g.dy;
    if (fx < 0 || fy < 0 || fx > g.nx - 1 || fy > g.ny - 1) return null;
    if (this.kind === 'wave' && this.ec.land?.isLand(lon, lat)) return null;
    const x0 = Math.min(Math.floor(fx), g.nx - 2), y0 = Math.min(Math.floor(fy), g.ny - 2), tx = fx - x0, ty = fy - y0;
    const i = y0 * g.nx + x0, j = i + g.nx, out = {};
    for (const [name, a] of Object.entries(f)) {
      const v = (a[i] * (1 - tx) + a[i + 1] * tx) * (1 - ty) + (a[j] * (1 - tx) + a[j + 1] * tx) * ty;
      if (Number.isNaN(v)) return null;
      out[name] = v;
    }
    return out;
  }

  /** 螢幕上每格移動的像素(東、北) */
  velocity(s) {
    if (this.kind === 'wind') return [s.u * this.K.speed, s.v * this.K.speed];
    const n = Math.hypot(s.x, s.y) || 1, k = (this.K.speed * s.t) / n;
    return [s.x * k, s.y * k];
  }

  valueAt(lng, lat) {
    if (!this.visible) return null;
    const s = this.sample(lng, lat);
    if (!s) return null;
    if (this.kind === 'wind') return `風場 ${dirName(-s.u, -s.v)}風 ${Math.hypot(s.u, s.v).toFixed(1)} m/s`;
    const c = waveClass(s.h);
    const ext = this.ec.coastAt(lng, lat) ? '（近岸外推）' : '';
    return `海浪 ${s.h.toFixed(1)} m${c ? `（${c}）` : ''} 來自${dirName(-s.x, -s.y)} ${s.t.toFixed(1)} s${ext}`;
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
    const [a0, a1] = this.K.age;
    p.x = box.x0 + Math.random() * (box.x1 - box.x0);
    p.y = box.y0 + Math.random() * (box.y1 - box.y0);
    const ll = this.map.unproject([p.x, p.y]);
    p.lon = ll.lng; p.lat = ll.lat;
    p.age = 0;
    p.max = a0 + Math.random() * (a1 - a0);
    return p;
  }

  reseed() {
    if (!this.visible) return;
    this.clear();
    this.box_ = this.box();
    const b = this.box_;
    if (!b) { this.particles = []; return; }
    const n = Math.min(Math.round(((b.x1 - b.x0) * (b.y1 - b.y0) / this.K.areaPer) * this.density), MAX_N);
    this.particles = Array.from({ length: n }, () => {
      const p = this.spawn({}, b);
      p.age = Math.random() * p.max;          // 錯開壽命,才不會同時重生
      return p;
    });
  }

  /** 拖動 / 縮放中:清掉畫面,粒子留在原經緯度、重算螢幕位置 */
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
    const ctx = this.ctx, m = this.map, b = this.box_, wave = this.kind === 'wave';
    if (wave) this.clear();
    else {
      ctx.globalCompositeOperation = 'destination-in';         // 舊尾跡變淡(透明),底圖不受影響
      ctx.fillStyle = `rgba(0,0,0,${FADE})`;
      ctx.fillRect(0, 0, this.W, this.H);
      ctx.globalCompositeOperation = 'source-over';
    }
    if (!this.f || !b || m.isMoving()) return;
    const ppd = (512 * 2 ** m.getZoom()) / 360;               // 赤道上每度經度幾像素
    const bySpeed = this.color === 'speed', paths = new Map();
    const path = (key) => { if (!paths.has(key)) paths.set(key, new Path2D()); return paths.get(key); };
    for (const p of this.particles) {
      const s = ++p.age > p.max ? null : this.sample(p.lon, p.lat);
      if (!s) { this.spawn(p, b); continue; }
      const [vx, vy] = this.velocity(s);
      const lon = p.lon + vx / ppd, lat = p.lat + (vy * Math.cos((p.lat * Math.PI) / 180)) / ppd;
      const q = m.project([lon, lat]);
      if (q.x < b.x0 || q.x > b.x1 || q.y < b.y0 || q.y > b.y1) { this.spawn(p, b); continue; }
      if (wave) {
        // 波峰:垂直前進方向的弧,往前凸;半長 3–23 px 隨浪高;淡入淡出
        const n = Math.hypot(vx, vy) || 1, dx = vx / n, dy = -vy / n, L = 3 + 2.5 * Math.min(s.h, 8);
        const a = Math.min(Math.floor(Math.sin((Math.PI * p.age) / p.max) * ALPHAS.length), ALPHAS.length - 1);
        const c = bySpeed ? levelOf(SCALES.wave.levels, s.h) : 0;
        const pa = path(c * ALPHAS.length + a);
        pa.moveTo(q.x + dy * L, q.y - dx * L);
        pa.quadraticCurveTo(q.x + dx * L * 0.8, q.y + dy * L * 0.8, q.x - dy * L, q.y + dx * L);
      } else {
        const pa = path(bySpeed ? beaufort(Math.hypot(s.u, s.v)) : 0);
        pa.moveTo(p.x, p.y);
        pa.lineTo(q.x, q.y);
      }
      p.x = q.x; p.y = q.y; p.lon = lon; p.lat = lat;
    }
    ctx.lineWidth = wave ? 1.6 : 1.3;
    ctx.lineCap = 'round';
    for (const [key, pa] of paths) {
      const c = wave ? Math.floor(key / ALPHAS.length) : key;
      const colors = wave ? SCALES.wave.colors : SCALES.wind.colors;
      ctx.globalAlpha = wave ? ALPHAS[key % ALPHAS.length] : 1;
      ctx.strokeStyle = bySpeed ? colors[Math.min(c, colors.length - 1)] : COLORS[this.color];
      ctx.stroke(pa);
    }
    ctx.globalAlpha = 1;
  }

  legend() {
    const s = this.shown, when = s ? `（${fmtEcInit(s.init)} +${Math.round(s.hours * 10) / 10}h）` : '（無資料）';
    if (this.kind === 'wave') {
      const title = `海浪動畫：ECMWF 海浪預報${when}`, note = `波峰往浪前進方向移動；越長浪越高、越快週期越長。${TIME_NOTE}`;
      return this.color === 'speed'
        ? withInfo(legendHTML(`${title} 波峰顏色 = 浪高 (m)`, SCALES.wave.levels, SCALES.wave.colors, 0, 22, SCALES.wave.ticks), note)
        : `<div class="legend-title">${title}${infoHTML(note)}</div>`;
    }
    const title = `風場動畫：ECMWF 10 m 風預報${when}`, note = `粒子順著風吹去的方向流動，越快風越大。${TIME_NOTE}`;
    return this.color === 'speed' ? withInfo(beaufortLegendHTML(`${title} 粒子顏色（蒲福風級）`, SCALES.wind.colors), note)
      : `<div class="legend-title">${title}${infoHTML(note)}</div>`;
  }
}

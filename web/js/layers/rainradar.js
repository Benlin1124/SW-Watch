// 降雨雷達(氣象署 O-A0084 樹林、南屯、林園;pipeline/fetch_rainradar.py 由回波圖依色標還原 dBZ):
// 每站一個 image source / raster 圖層,格式同雷達整合回波(uint8,0.5 dBZ 一階,0 = 無回波,255 = 範圍外)。
// 約每 2 分鐘一張:歷史每 10 分鐘留一張,另留最新一張 → 同步時取 [T, T+10 分) 內最新的那張。
import { getGrid, getIndex } from '../data.js';
import { DBZ_COLORS, DBZ_LEVELS, legendHTML, radarLUT } from '../colormaps.js';
import { addMin, latestLE } from '../time.js';
import { EMPTY_PNG, renderPNG } from './radar.js';

export const RR_SITES = [
  { id: 'shulin', name: '樹林' },
  { id: 'nantun', name: '南屯' },
  { id: 'linyuan', name: '林園' },
];
const CACHE_MAX = 60;           // 每站

export class RainRadarLayer {
  key = 'rainradar';
  name = '降雨雷達';
  cadence = null;               // 時間不在整 10 分上:時間軸色帶依所在的格畫
  staleMin = 10;
  visible = false;
  opacity = 0.85;
  site = 'all';                 // 'all' = 三站都畫;或單一站 id

  constructor(map) {
    this.map = map;
    this.sites = RR_SITES.map((s) => ({ ...s, index: null, cache: new Map(), current: null, pick: null }));
  }

  get shown() { return this.sites.filter((s) => s.index && (this.site === 'all' || this.site === s.id)); }
  get index() { return this.sites.some((s) => s.index) ? {} : null; }
  get times() { return [...new Set(this.shown.flatMap((s) => s.index.times))].sort(); }
  get latest() { const t = this.times; return t[t.length - 1] ?? null; }

  async load() {
    await Promise.all(this.sites.map(async (s) => {
      try { s.index = await getIndex(`rainradar/${s.id}`); } catch { /* 這站還沒有資料 */ }
      if (s.index) this.lut ??= radarLUT(s.index.grid);
    }));
    if (!this.sites.some((s) => s.index)) throw new Error('rainradar index 404');
  }

  addTo(beforeId) {
    for (const s of this.sites) {
      const g = s.index?.grid;
      this.map.addSource(`rr-${s.id}`, { type: 'image', url: EMPTY_PNG, coordinates: g?.corners ?? [[120, 23], [121, 23], [121, 22], [120, 22]] });
      this.map.addLayer({ id: `rr-${s.id}`, type: 'raster', source: `rr-${s.id}`,
        layout: { visibility: 'none' },
        paint: { 'raster-opacity': this.opacity, 'raster-resampling': 'nearest', 'raster-fade-duration': 0 } }, beforeId);
    }
    this.applyVisibility();
  }

  /** 各站要顯示的時間:同步 = [T, T+10 分) 內最新;不同步 = 最新。回傳最新的那個(時間欄顯示用) */
  pick(T, sync) {
    for (const s of this.sites) {
      const t = s.index?.times ?? [];
      if (!sync) s.pick = t[t.length - 1] ?? null;
      else {
        const c = latestLE(t, addMin(T, 9));
        s.pick = c && c >= T ? c : null;
      }
    }
    const ps = this.shown.map((s) => s.pick).filter(Boolean).sort();
    return ps[ps.length - 1] ?? null;
  }

  /** 時間軸對齊的格 → 各站實際要預載的時間 */
  framesFor(slots) {
    const out = new Set();
    for (const T of slots) for (const s of this.shown) {
      const c = latestLE(s.index.times, addMin(T, 9));
      if (c && c >= T) out.add(`${s.id}|${c}`);
    }
    return [...out];
  }

  frame(s, stamp) {
    if (!s.cache.has(stamp)) {
      const g = s.index.grid;
      const p = getGrid(`rainradar/${s.id}`, stamp, g).then(async (raw) => ({ raw, url: await renderPNG(raw, g, this.lut) }));
      p.catch(() => s.cache.delete(stamp));
      s.cache.set(stamp, p);
      if (s.cache.size > CACHE_MAX) {
        const [old, f] = s.cache.entries().next().value;
        s.cache.delete(old);
        f.then((x) => URL.revokeObjectURL(x.url)).catch(() => {});
      }
    }
    return s.cache.get(stamp);
  }

  async show(stamp) {
    await Promise.all(this.sites.map(async (s) => {
      if (!s.index) return;
      const want = stamp && (this.site === 'all' || this.site === s.id) ? s.pick : null;
      if (s.current?.stamp === want || (!want && !s.current)) return;
      s.wanted = want;
      const src = this.map.getSource(`rr-${s.id}`);
      if (!want) {
        src.updateImage({ url: EMPTY_PNG, coordinates: s.index.grid.corners });
        s.current = null;
        return;
      }
      const f = await this.frame(s, want);
      if (s.wanted !== want) return;
      src.updateImage({ url: f.url, coordinates: s.index.grid.corners });
      s.current = { stamp: want, raw: f.raw };
    }));
  }

  async prefetch(keys, onProgress) {
    let done = 0;
    const queue = [...keys];
    const worker = async () => {
      while (queue.length) {
        const [id, t] = queue.shift().split('|');
        try { await this.frame(this.sites.find((s) => s.id === id), t); } catch { /* 缺檔就算了 */ }
        onProgress?.(++done, keys.length);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  }

  applyVisibility() {
    for (const s of this.sites) {
      if (!this.map.getLayer(`rr-${s.id}`)) continue;
      const on = this.visible && (this.site === 'all' || this.site === s.id);
      this.map.setLayoutProperty(`rr-${s.id}`, 'visibility', on ? 'visible' : 'none');
    }
  }

  setVisible(v) { this.visible = v; this.applyVisibility(); }
  setSite(id) { this.site = id; this.applyVisibility(); }

  setOpacity(v) {
    this.opacity = v;
    for (const s of this.sites) if (this.map.getLayer(`rr-${s.id}`)) this.map.setPaintProperty(`rr-${s.id}`, 'raster-opacity', v);
  }

  /** 游標位置的 dBZ:各站取最大(三站重疊時) */
  valueAt(lng, lat) {
    if (!this.visible) return null;
    let best = null, inside = false;
    for (const s of this.shown) {
      if (!s.current) continue;
      const g = s.index.grid;
      const ix = Math.round((lng - g.lon0) / g.dx), iy = Math.round((lat - g.lat0) / g.dy);
      if (ix < 0 || iy < 0 || ix >= g.nx || iy >= g.ny) continue;
      const raw = s.current.raw[iy * g.nx + ix];
      if (raw === g.nodata) continue;
      inside = true;
      if (raw > 0 && (!best || raw > best.raw)) best = { raw, v: raw * g.scale + g.offset, name: s.name };
    }
    if (best) return `降雨雷達 ${best.v.toFixed(0)} dBZ（${best.name}）`;
    return inside ? '降雨雷達 無回波' : null;
  }

  legend() { return legendHTML('降雨雷達 (dBZ)', DBZ_LEVELS, DBZ_COLORS); }
}

// 陸地遮罩(設計log「海浪海岸遮罩」):和底圖同一份 land.json(Natural Earth 10m + 內政部台灣外框)
// 海浪模式陸地沒有值、邊緣是 0.1° 方塊;先往陸地外推幾格,再用這份陸地挖掉 → 邊緣貼齊底圖海岸線。
//   polygons:範圍內的多邊形(經緯度環),畫 canvas 用(每個多邊形各自 evenodd,湖泊是洞)
//   isLand(lon, lat):0.01° 點陣查表,動畫粒子 / 箭頭 / 點擊查值用;範圍很大(西北太平洋),點陣切成 CHUNK 度的塊、查到才畫
const URL_LAND = new URL('../assets/basemap/land.json', import.meta.url).href;
const RES = 0.01;
const CHUNK = 5;                  // 點陣一塊 5°×5°(500×500)
const cache = new Map();          // 範圍 → Promise<LandMask>

export function landMask(west, south, east, north) {
  const key = [west, south, east, north].join(',');
  if (!cache.has(key)) {
    const p = fetch(URL_LAND).then((r) => { if (!r.ok) throw new Error(`land.json ${r.status}`); return r.json(); })
      .then((gj) => new LandMask(gj, west, south, east, north));
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return cache.get(key);
}

class LandMask {
  constructor(gj, west, south, east, north) {
    Object.assign(this, { west, south, east, north });
    this.polygons = [];
    this.boxes = [];             // 各多邊形外框 [x0, y0, x1, y1]
    for (const f of gj.features) {
      const g = f.geometry, list = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
      for (const poly of list) {
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (const [x, y] of poly[0]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
        if (x1 >= west && x0 <= east && y1 >= south && y0 <= north) { this.polygons.push(poly); this.boxes.push([x0, y0, x1, y1]); }
      }
    }
    this.chunks = new Map();     // 'cx,cy' → Uint8Array(N×N),1 = 陸地
  }

  /** 第 (cx, cy) 塊的點陣(第一次查到才畫) */
  chunk(cx, cy) {
    const key = `${cx},${cy}`;
    let bits = this.chunks.get(key);
    if (!bits) {
      const N = Math.round(CHUNK / RES), w = this.west + cx * CHUNK, n = this.south + (cy + 1) * CHUNK;
      const cv = document.createElement('canvas');
      cv.width = N; cv.height = N;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#000';
      this.fill(ctx, (lon) => (lon - w) / RES, (lat) => (n - lat) / RES, [w, n - CHUNK, w + CHUNK, n]);
      const a = ctx.getImageData(0, 0, N, N).data;
      bits = new Uint8Array(N * N);
      for (let i = 0; i < bits.length; i++) bits[i] = a[i * 4 + 3] > 127 ? 1 : 0;
      this.chunks.set(key, bits);
    }
    return bits;
  }

  /** 把陸地畫到 ctx(px(lon)、py(lat) 換算成 canvas 座標);bbox = [w, s, e, n] 只畫和它相交的;fillStyle / 合成方式由呼叫端設定 */
  fill(ctx, px, py, bbox = null) {
    for (const [k, poly] of this.polygons.entries()) {
      const b = this.boxes[k];
      if (bbox && (b[2] < bbox[0] || b[0] > bbox[2] || b[3] < bbox[1] || b[1] > bbox[3])) continue;
      const p = new Path2D();
      for (const ring of poly) {
        ring.forEach(([lon, lat], i) => (i ? p.lineTo(px(lon), py(lat)) : p.moveTo(px(lon), py(lat))));
        p.closePath();
      }
      ctx.fill(p, 'evenodd');
    }
  }

  isLand(lon, lat) {
    if (lon < this.west || lon >= this.east || lat < this.south || lat >= this.north) return false;
    const N = Math.round(CHUNK / RES);
    const ix = Math.floor((lon - this.west) / RES), iy = Math.floor((lat - this.south) / RES);
    const cx = Math.floor(ix / N), cy = Math.floor(iy / N);
    return this.chunk(cx, cy)[(N - 1 - (iy - cy * N)) * N + (ix - cx * N)] === 1;
  }
}

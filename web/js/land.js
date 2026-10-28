// 陸地遮罩(設計log「海浪海岸遮罩」):和底圖同一份 land.json(Natural Earth 10m + 內政部台灣外框)
// 海浪模式陸地沒有值、邊緣是 0.1° 方塊;先往陸地外推幾格,再用這份陸地挖掉 → 邊緣貼齊底圖海岸線。
//   polygons:範圍內的多邊形(經緯度環),畫 canvas 用(每個多邊形各自 evenodd,湖泊是洞)
//   isLand(lon, lat):0.01° 點陣查表,動畫粒子 / 箭頭 / 點擊查值用
const URL_LAND = new URL('../assets/basemap/land.json', import.meta.url).href;
const RES = 0.01;
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
    for (const f of gj.features) {
      const g = f.geometry, list = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
      for (const poly of list) {
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (const [x, y] of poly[0]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
        if (x1 >= west && x0 <= east && y1 >= south && y0 <= north) this.polygons.push(poly);
      }
    }
    this.nx = Math.ceil((east - west) / RES);
    this.ny = Math.ceil((north - south) / RES);
    const cv = document.createElement('canvas');
    cv.width = this.nx; cv.height = this.ny;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#000';
    this.fill(ctx, (lon) => (lon - west) / RES, (lat) => (north - lat) / RES);
    const a = ctx.getImageData(0, 0, this.nx, this.ny).data;
    this.bits = new Uint8Array(this.nx * this.ny);
    for (let i = 0; i < this.bits.length; i++) this.bits[i] = a[i * 4 + 3] > 127 ? 1 : 0;
  }

  /** 把陸地畫到 ctx(px(lon)、py(lat) 換算成 canvas 座標);fillStyle / 合成方式由呼叫端設定 */
  fill(ctx, px, py) {
    for (const poly of this.polygons) {
      const p = new Path2D();
      for (const ring of poly) {
        ring.forEach(([lon, lat], i) => (i ? p.lineTo(px(lon), py(lat)) : p.moveTo(px(lon), py(lat))));
        p.closePath();
      }
      ctx.fill(p, 'evenodd');
    }
  }

  isLand(lon, lat) {
    const ix = Math.floor((lon - this.west) / RES), iy = Math.floor((this.north - lat) / RES);
    if (ix < 0 || iy < 0 || ix >= this.nx || iy >= this.ny) return false;
    return this.bits[iy * this.nx + ix] === 1;
  }
}

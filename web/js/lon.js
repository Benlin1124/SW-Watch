// 經度跨 180°(換日線):颱風、系集路徑一律換成 0–360°(西經 −179 → 181),
// 線才不會從 179°E 橫拉到 −179°(穿過整張地圖),系集平均也不會把 179 和 −179 平均成 0。
// MapLibre 可以直接畫 180 以上的經度(接在東邊的世界副本上)。

export const lon360 = (x) => (x != null && x < 0 ? x + 360 : x);

/** GeoJSON 幾何的座標全部換成 0–360°(原地修改) */
export function geom360(g) {
  const fix = (c) => (typeof c[0] === 'number' ? (c[0] = lon360(c[0]), c) : c.forEach(fix));
  if (g?.coordinates) fix(g.coordinates);
  return g;
}

/** 顯示用:180 以上標西經 */
export const fmtLon = (x) => (x > 180 ? `${(360 - x).toFixed(1)}°W` : `${(+x).toFixed(1)}°E`);

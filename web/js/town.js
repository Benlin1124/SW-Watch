// 滑鼠讀值的鄉鎮名:town_names.json(pipeline/build_basemap.py;內政部鄉鎮界,約 100 m 精度)
// 滑鼠第一次移到台灣附近才下載;townAt 先比外框再做點在多邊形內判斷(evenodd,洞也算)
const URL_TOWN = new URL('../assets/basemap/town_names.json', import.meta.url).href;
const AREA = [118, 21.8, 124.6, 26.5];       // 台澎金馬範圍,外面不查也不下載
let towns = null, loading = null;

function load() {
  loading ??= fetch(URL_TOWN).then((r) => { if (!r.ok) throw new Error(`town_names.json ${r.status}`); return r.json(); })
    .then((gj) => {
      towns = gj.features.map((f) => {
        const polys = f.geometry.coordinates;
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (const p of polys) for (const [x, y] of p[0]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
        return { name: `${f.properties.c}${f.properties.t}`, polys, box: [x0, y0, x1, y1] };
      });
    })
    .catch((e) => { console.warn('鄉鎮界載入失敗', e); loading = null; });
  return loading;
}

function inside(rings, lon, lat) {
  let c = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) c = !c;
    }
  }
  return c;
}

/** (lon, lat) 所在的「縣市鄉鎮」;不在台灣或還沒載入 → '' */
export function townAt(lon, lat) {
  if (lon < AREA[0] || lon > AREA[2] || lat < AREA[1] || lat > AREA[3]) return '';
  if (!towns) { load(); return ''; }
  for (const t of towns) {
    const [x0, y0, x1, y1] = t.box;
    if (lon < x0 || lon > x1 || lat < y0 || lat > y1) continue;
    if (t.polys.some((p) => inside(p, lon, lat))) return t.name;
  }
  return '';
}

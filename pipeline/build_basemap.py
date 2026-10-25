"""產生素色向量底圖(仿 notebook 的 cartopy 底圖:淺灰陸地、白色海洋、黑色海岸線與縣市界)。
  Natural Earth 10m(公有領域)陸地 / 海岸線 / 國界 + NCDR 台灣縣市界、台灣周圍 100 公里線(km100)
  → web/assets/basemap/*.json(裁到西北太平洋、簡化、座標取 4 位小數)
只需在更新底圖時執行一次:python -m pipeline.build_basemap [--src 已下載的目錄] [--only km100]"""
import argparse
import json
from pathlib import Path

import requests
import shapely
from shapely.geometry import mapping, shape

from . import config

OUT = config.ROOT / "web" / "assets" / "basemap"
EXTENT = (90, -15, 180, 60)            # 涵蓋衛星範圍 105–155E、5–35N 與颱風路徑
NE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/{}.geojson"
SOURCES = {
    "land": (NE.format("ne_10m_land"), 0.01),
    "coast": (NE.format("ne_10m_coastline"), 0.005),
    "borders": (NE.format("ne_10m_admin_0_boundary_lines_land"), 0.01),
    "taiwan": (config.TAIWAN_GEOJSON_URL, 0.0005),
    "km100": ("https://watch.ncdr.nat.gov.tw/00_Wxmap/json/area/100KM.json", 0.002),
}


def load(name, url, src_dir):
    local = src_dir / Path(url).name if src_dir else None
    if local and local.exists():
        return json.loads(local.read_text(encoding="utf-8"))
    r = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=120)
    r.encoding = "utf-8-sig"
    return json.loads(r.text)


def build(name, gj, tol):
    box = shapely.box(*EXTENT)
    feats = []
    for f in gj["features"]:
        g = shapely.make_valid(shape(f["geometry"]))
        if not g.intersects(box):
            continue
        lines = name in ("taiwan", "km100")
        g = shapely.clip_by_rect(g, *EXTENT) if not lines else g
        if lines:                               # 縣市、100 公里線只畫界線(make_valid 後可能是 GeometryCollection)
            polys = [x for x in shapely.get_parts(g) if x.geom_type in ("Polygon", "MultiPolygon")]
            g = shapely.union_all([x.boundary for x in polys])
        g = shapely.set_precision(g.simplify(tol, preserve_topology=True), 0.0001)
        if not g.is_empty:
            feats.append({"type": "Feature", "properties": {}, "geometry": mapping(g)})
    return {"type": "FeatureCollection", "features": feats}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", type=Path, help="已下載原始檔的目錄(檔名同來源網址)")
    ap.add_argument("--only", nargs="+", choices=list(SOURCES), help="只產生這幾個")
    a = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    for name, (url, tol) in SOURCES.items():
        if a.only and name not in a.only:
            continue
        fc = build(name, load(name, url, a.src), tol)
        path = OUT / f"{name}.json"
        path.write_text(json.dumps(fc, separators=(",", ":")), encoding="utf-8")
        print(f"{name}: {len(fc['features'])} features, {path.stat().st_size / 1e3:.0f} KB")


if __name__ == "__main__":
    main()

"""產生素色向量底圖(仿 notebook 的 cartopy 底圖:淺灰陸地、白色海洋、黑色海岸線與縣市界)。
  Natural Earth 10m(公有領域)陸地 / 海岸線 / 國界 + 台灣縣市界(shp/TWN_CITY.shp 內政部;沒有就用 NCDR)、台灣周圍 100 公里線(km100)
  + 鄉鎮界(town:shp/TWN_TOWN.shp 內政部,只留縣市界、海岸線以外的段;網頁放大後才顯示)
  + 鄉鎮多邊形(town_names:縣市 c、鄉鎮 t,簡化較粗,網頁滑鼠讀值查鄉鎮名用)
  台灣附近的海岸線、陸地改用縣市界外框(兩份來源位置不同,不換會畫出兩條海岸線)
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
    "town": (None, 0.0005),          # shp/TWN_TOWN.shp
    "town_names": (None, 0.001),
}


TWN_CITY = config.ROOT / "shp" / "TWN_CITY.shp"     # 內政部縣市界(影片 radar_video 也用這份;shp/ 不進 git)
TWN_TOWN = config.ROOT / "shp" / "TWN_TOWN.shp"     # 內政部鄉鎮市區界


def load(name, url, src_dir):
    if name == "taiwan" and TWN_CITY.exists():     # 有內政部縣市界就用它(比 NCDR 細,網頁和影片一致)
        import shapefile
        r = shapefile.Reader(str(TWN_CITY), encoding="utf-8")
        return {"type": "FeatureCollection",
                "features": [{"type": "Feature", "properties": {}, "geometry": s.__geo_interface__} for s in r.shapes()]}
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


def taiwan_area(gj):
    """縣市多邊形聯集(台灣本島、澎湖、金門、馬祖與附屬島嶼)。"""
    tol = SOURCES["taiwan"][1]
    polys = [x.simplify(tol, preserve_topology=True)            # 先各自簡化再聯集(內政部縣市界很細,直接聯集很吃記憶體)
             for f in gj["features"] for x in shapely.get_parts(shapely.make_valid(shape(f["geometry"])))
             if x.geom_type in ("Polygon", "MultiPolygon")]
    return shapely.union_all(polys)


def replace_taiwan(name, fc, tw):
    """台灣附近改用縣市界外框:Natural Earth 海岸線 / 陸地和縣市界位置差幾百公尺到 1–2 公里,
    兩份都畫會出現兩條海岸線、陸地填色也對不齊 → Natural Earth 的島嶼 / 海岸線段「大部分」落在縣市聯集外擴 TW_PAD 內的,
    整段拿掉(台灣、澎湖、金門、馬祖與附屬島);只有一小段靠近的(例如廈門、福州的大陸海岸)保留,不會被挖出缺口。
    陸地補上縣市聯集、海岸線補上縣市聯集的外框(關掉縣市界時台灣仍有海岸線)。"""
    near = tw.simplify(0.005).buffer(TW_PAD, quad_segs=4)      # 判斷用,不用精細(高解析外擴很吃記憶體)
    feats = []
    for f in fc["features"]:
        keep = []
        for part in shapely.get_parts(shape(f["geometry"])):
            line = part.boundary if name == "land" else part          # 陸地也用外框長度判斷,和海岸線同一個標準(才不會留下沒外框的陸地)
            if line.length and shapely.intersection(line, near).length / line.length > 0.5:
                continue                                        # 台灣的島:整段換成縣市界
            keep.append(part)
        if keep:
            g = shapely.union_all(keep) if name == "land" else shapely.multilinestrings(keep) if len(keep) > 1 else keep[0]
            feats.append({**f, "geometry": mapping(shapely.set_precision(g, 0.0001))})
    add = tw if name == "land" else tw.boundary
    feats.append({"type": "Feature", "properties": {"src": "TWN_CITY"},
                  "geometry": mapping(shapely.set_precision(add, 0.0001))})
    return {"type": "FeatureCollection", "features": feats}


def build_town(tol):
    """鄉鎮界線:各鄉鎮外框聯集,扣掉縣市界與海岸線(那些已有,疊兩次會變粗)。"""
    import shapefile
    def outlines(path):
        r = shapefile.Reader(str(path), encoding="utf-8")
        polys = [x.simplify(tol, preserve_topology=True) for s in r.shapes()
                 for x in shapely.get_parts(shapely.make_valid(shape(s.__geo_interface__)))
                 if x.geom_type in ("Polygon", "MultiPolygon")]
        return shapely.union_all([p.boundary for p in polys])
    town, county = outlines(TWN_TOWN), outlines(TWN_CITY)
    g = shapely.line_merge(shapely.difference(town, county.buffer(tol * 2, quad_segs=2)))
    g = shapely.set_precision(g, 0.0001)
    return {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {}, "geometry": mapping(g)}]}


def build_town_names(tol):
    """鄉鎮多邊形 + 名稱(滑鼠讀值用,約 100 m 精度就夠)。"""
    import shapefile
    r = shapefile.Reader(str(TWN_TOWN), encoding="utf-8")
    feats = []
    for s, rec in zip(r.shapes(), r.records()):
        g = shapely.make_valid(shape(s.__geo_interface__)).simplify(tol, preserve_topology=True)
        g = shapely.set_precision(g, 0.0001)
        polys = [x for x in shapely.get_parts(g) if x.geom_type == "Polygon" and not x.is_empty]
        if polys:
            feats.append({"type": "Feature", "properties": {"c": rec["COUNTYNAME"], "t": rec["TOWNNAME"]},
                          "geometry": mapping(shapely.MultiPolygon(polys))})
    return {"type": "FeatureCollection", "features": feats}


TW_PAD = 0.03        # 縣市聯集外擴(度,約 3 km):Natural Earth 的島 / 海岸線段一半以上在這範圍內就換成縣市界


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", type=Path, help="已下載原始檔的目錄(檔名同來源網址)")
    ap.add_argument("--only", nargs="+", choices=list(SOURCES), help="只產生這幾個")
    a = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    tw = taiwan_area(load("taiwan", SOURCES["taiwan"][0], a.src))
    for name, (url, tol) in SOURCES.items():
        if a.only and name not in a.only:
            continue
        if name in ("town", "town_names"):
            if not TWN_TOWN.exists():
                print(f"{name}: 沒有 shp/TWN_TOWN.shp,略過")
                continue
            fc = build_town(tol) if name == "town" else build_town_names(tol)
        else:
            fc = build(name, load(name, url, a.src), tol)
        if name in ("land", "coast"):
            fc = replace_taiwan(name, fc, tw)
        path = OUT / f"{name}.json"
        path.write_text(json.dumps(fc, separators=(",", ":")), encoding="utf-8")
        print(f"{name}: {len(fc['features'])} features, {path.stat().st_size / 1e3:.0f} KB")


if __name__ == "__main__":
    main()

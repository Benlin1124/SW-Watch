"""CWA 颱風消息原始 JSON → 前端用的精簡格式(含 70% 潛勢區、暴風圈多邊形)。
  data/typhoon/cwa_track/{發布時間}.json
重建全部:python -m pipeline.typhoon_cwa --rebuild"""
import argparse
import gzip
import json
from datetime import datetime

import numpy as np
import shapely
from pyproj import Geod
from shapely.geometry import Polygon, mapping

from . import config
from .common import log, save_json, update_index, utc_stamp

LAYER = "typhoon/cwa_track"
GEOD = Geod(ellps="WGS84")
QUADS = ("NE", "SE", "SW", "NW")      # 方位角 0–90、90–180、180–270、270–360
CARRY_HOURS = 12                      # 新一報沒有的颱風,沿用前報最多幾小時(以該颱風自己的預報初始時間算)


def _num(v):
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return None if x < 0 else x


def _radii(circle):
    """Circle15ms / Circle25ms → (平均半徑, [NE, SE, SW, NW] 或 None),單位 km。"""
    if not circle:
        return None, None
    r = _num(circle.get("Radius"))
    q = (circle.get("QuadrantRadii") or {}).get("Radius")
    quad = None
    if q:
        q = q if isinstance(q, list) else [q]
        d = {x.get("@dir"): _num(x.get("#text")) for x in q}
        if all(d.get(k) is not None for k in QUADS):
            quad = [d[k] for k in QUADS]
    return r, quad


def geo_circle(lon, lat, radius_km, n=72):
    """大地測量圓;radius_km 可為純量或四象限 [NE, SE, SW, NW]。"""
    az = np.linspace(0, 360, n, endpoint=False)
    if isinstance(radius_km, (list, tuple)):
        r = np.array([radius_km[min(int(a // 90), 3)] for a in az], dtype=float)
    else:
        r = np.full(n, float(radius_km))
    lons, lats, _ = GEOD.fwd(np.full(n, lon), np.full(n, lat), az, r * 1000)
    return Polygon(zip(lons, lats))


def potential_cone(center, fcst):
    """70% 機率潛勢區:現在位置(半徑 0)+ 各預報點 70% 半徑,相鄰兩圓取凸包後聯集。"""
    circles = [shapely.Point(center).buffer(1e-4)]
    for p in fcst:
        if p["r70"]:
            circles.append(geo_circle(p["lon"], p["lat"], p["r70"]))
    if len(circles) < 2:
        return None
    hulls = [shapely.union(a, b).convex_hull for a, b in zip(circles[:-1], circles[1:])]
    return shapely.union_all(hulls).simplify(0.005)


def _round_geom(g):
    if g is None or g.is_empty:
        return None
    return mapping(shapely.set_precision(g, 0.0001))


def convert_tc(tc):
    past = []
    for f in (tc.get("AnalysisData") or {}).get("Fix") or []:
        r15, q15 = _radii(f.get("Circle15ms"))
        r25, q25 = _radii(f.get("Circle25ms"))
        past.append(dict(
            t=utc_stamp(f["DateTime"]), lon=float(f["CoordinateLongitude"]),
            lat=float(f["CoordinateLatitude"]), wind=_num(f.get("MaxWindSpeed")),
            gust=_num(f.get("MaxGustSpeed")), pres=_num(f.get("Pressure")),
            mv_spd=_num(f.get("MovingSpeed")), mv_dir=f.get("MovingDirection"),
            r15=r15, r25=r25, r15q=q15, r25q=q25))
    past.sort(key=lambda p: p["t"])

    fcst, init = [], None
    for f in (tc.get("ForecastData") or {}).get("Fix") or []:
        init = utc_stamp(f["InitialTime"])
        r15, _ = _radii(f.get("Circle15ms"))
        r25, _ = _radii(f.get("Circle25ms"))
        fcst.append(dict(
            tau=int(f["ForecastHour"]), lon=float(f["CoordinateLongitude"]),
            lat=float(f["CoordinateLatitude"]), wind=_num(f.get("MaxWindSpeed")),
            gust=_num(f.get("MaxGustSpeed")), pres=_num(f.get("Pressure")),
            r15=r15, r25=r25, r70=_num(f.get("Radius70PercentProbability"))))
    fcst.sort(key=lambda p: p["tau"])

    now = past[-1] if past else None
    geo = {}
    if now:
        for key in ("15", "25"):
            r = now[f"r{key}q"] or now[f"r{key}"]
            if r:
                geo[f"circle{key}"] = _round_geom(geo_circle(now["lon"], now["lat"], r))
        if fcst:
            geo["cone70"] = _round_geom(potential_cone((now["lon"], now["lat"]), fcst))

    ty_no, td_no = tc.get("CwaTyNo"), tc.get("CwaTdNo")
    return dict(
        id=f'{tc.get("Year")}_{"TY" + ty_no if ty_no else "TD" + str(td_no)}',
        year=tc.get("Year"), name_zh=tc.get("CwaTyphoonName"), name_en=tc.get("TyphoonName"),
        ty_no=ty_no, td_no=td_no, past=past, fcst_init=init, fcst=fcst, geo=geo)


def convert(od):
    """檔名時間 = 預報初始時間(多個颱風取最晚者);沒有預報(例如已無颱風)才用發布時間。"""
    tcs = ((od.get("Dataset") or {}).get("TropicalCyclones") or {}).get("TropicalCyclone") or []
    tcs = tcs if isinstance(tcs, list) else [tcs]
    storms = [convert_tc(tc) for tc in tcs]
    issued = utc_stamp(od["Sent"])
    inits = [s["fcst_init"] for s in storms if s["fcst_init"]]
    return {"init": max(inits) if inits else issued, "issued": issued,
            "source": "CWA W-C0034-005", "storms": storms}


def _hours(a, b):
    return (datetime.strptime(b, "%Y%m%d%H%M") - datetime.strptime(a, "%Y%m%d%H%M")).total_seconds() / 3600


def carry_over(out):
    """颱風警報期間每小時的報只含發警報的那個颱風,其他颱風仍照平常時段更新。
    新一報沒有的颱風,從前面各報(初始時間較早、CARRY_HOURS 內)找它最近一次的內容沿用,標 carried,
    保留它自己的預報初始時間;往回找多檔,所以中間有一檔漏掉也接得回來。
    超過 CARRY_HOURS 沒再出現就視為已不發布。"""
    have = {s["id"] for s in out["storms"]}
    found = {}
    for p in sorted((config.DATA_DIR / LAYER).glob("*.json"), reverse=True):
        if p.stem >= out["init"]:
            continue
        if _hours(p.stem, out["init"]) > CARRY_HOURS:
            break
        for s in json.loads(p.read_text(encoding="utf-8")).get("storms", []):
            t = s.get("fcst_init") or (s["past"][-1]["t"] if s.get("past") else None)
            if s["id"] not in have and s["id"] not in found and t and _hours(t, out["init"]) <= CARRY_HOURS:
                found[s["id"]] = {**s, "carried": True}
    out["storms"] += found.values()
    return out


def save(od):
    """同一個初始時間若重複發布(例如更正),以較晚發布的為準。"""
    out = carry_over(convert(od))
    path = config.DATA_DIR / LAYER / f'{out["init"]}.json'
    if path.exists() and json.loads(path.read_text(encoding="utf-8")).get("issued", "") > out["issued"]:
        return out
    save_json(path, out)
    update_index(LAYER, out["init"], source="CWA W-C0034-005", name="氣象署颱風路徑",
                 time_meaning="預報初始時間")
    return out


def rebuild():
    """清空後從原始歸檔全部重轉;單獨執行沒有排程 flush,最後自己上傳 R2。"""
    from . import r2
    for old in (config.DATA_DIR / LAYER).glob("*.json"):
        old.unlink()
    for p in sorted((config.DATA_DIR / "typhoon" / "cwa").glob("*.json.gz")):
        out = save(json.load(gzip.open(p)))
        log.info("typhoon 初始 %s(發布 %s):%s", out["init"], out["issued"], [s["name_zh"] for s in out["storms"]])
    up, _ = r2.flush()
    if up:
        log.info("typhoon 重建:R2 上傳 %d 檔", up)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--rebuild", action="store_true")
    if ap.parse_args().rebuild:
        import logging
        logging.basicConfig(level=logging.INFO)
        rebuild()

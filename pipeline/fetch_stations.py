"""測站:合併 O-A0001-001(自動站)、O-A0003-001(局屬站)、O-A0002-001(雨量站)
→ data/stations/{stamp}.json(所有變數一個檔,前端切換變數不用重抓)
並用同一批雨量做 IDW → data/rain/idw/{acc}/{stamp}.bin.gz。"""
from .common import fetch_cwa, log, save_points, utc_stamp
from . import config, idw

LAYER = "stations"

# 輸出欄位(順序即 rows 每列的順序)
META_FIELDS = ["id", "name", "lon", "lat", "alt", "county", "town", "obs"]
WX_FIELDS = ["temp", "rh", "pres", "ws", "wd", "gust", "gust_dir", "tmax", "tmin"]
RAIN_FIELDS = [f"rain_{k}" for k in config.RAIN_ACC]
FIELDS = META_FIELDS + WX_FIELDS + RAIN_FIELDS


def _num(v, allow_negative=False):
    """CWA 用 -99 / -999 / -998 等負值代表缺測。"""
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    if x <= -90 or (x < 0 and not allow_negative):
        return None
    return x


def _get(d, *keys):
    for k in keys:
        if not isinstance(d, dict):
            return None
        d = d.get(k)
    return d


def _wgs84(st):
    for c in st["GeoInfo"]["Coordinates"]:
        if c["CoordinateName"] == "WGS84":
            return float(c["StationLongitude"]), float(c["StationLatitude"])
    c = st["GeoInfo"]["Coordinates"][0]
    return (float(c["StationLongitude"]) + config.TWD67_DLON,
            float(c["StationLatitude"]) + config.TWD67_DLAT)


def _base(st):
    lon, lat = _wgs84(st)
    g = st["GeoInfo"]
    return {"id": st["StationId"], "name": st["StationName"], "lon": round(lon, 5),
            "lat": round(lat, 5), "alt": _num(g.get("StationAltitude"), True),
            "county": g.get("CountyName"), "town": g.get("TownName"),
            "obs": utc_stamp(st["ObsTime"]["DateTime"])}


def collect():
    sta = {}
    for code in ("O-A0001-001", "O-A0003-001"):
        for st in fetch_cwa(code)["dataset"]["Station"]:
            w = st["WeatherElement"]
            rec = sta.setdefault(st["StationId"], _base(st))
            rec.update(
                temp=_num(w.get("AirTemperature"), True),
                rh=_num(w.get("RelativeHumidity")),
                pres=_num(w.get("AirPressure")),
                ws=_num(w.get("WindSpeed")),
                wd=_num(w.get("WindDirection")),
                gust=_num(_get(w, "GustInfo", "PeakGustSpeed")),
                gust_dir=_num(_get(w, "GustInfo", "Occurred_at", "WindDirection")),
                tmax=_num(_get(w, "DailyExtreme", "DailyHigh", "TemperatureInfo", "AirTemperature"), True),
                tmin=_num(_get(w, "DailyExtreme", "DailyLow", "TemperatureInfo", "AirTemperature"), True),
            )
            if rec["temp"] is not None and rec["temp"] < -50:
                rec["temp"] = None

    rain_times = []
    for st in fetch_cwa("O-A0002-001")["dataset"]["Station"]:
        rec = sta.setdefault(st["StationId"], _base(st))
        rain_times.append(st["ObsTime"]["DateTime"])
        for acc, key in config.RAIN_ACC.items():
            rec[f"rain_{acc}"] = _num(_get(st, "RainfallElement", key, "Precipitation"))

    # 檔名時間 = 雨量站最新觀測時間(10 分鐘一筆)
    stamp = utc_stamp(max(rain_times))
    return stamp, list(sta.values())


def run():
    stamp, recs = collect()
    rows = [[r.get(f) for f in FIELDS] for r in recs]
    save_points(LAYER, stamp, {"time": stamp, "fields": FIELDS, "rows": rows},
                fields=FIELDS, source="CWA O-A0001-001 / O-A0003-001 / O-A0002-001")
    log.info("stations %s 完成(%d 站)", stamp, len(rows))
    idw.run(stamp, recs)
    return stamp


if __name__ == "__main__":
    run()

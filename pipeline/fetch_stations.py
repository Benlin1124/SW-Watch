"""測站:合併 O-A0001-001(自動站)、O-A0003-001(局屬站)、O-A0002-001(雨量站),
再加日本氣象廳宮古、八重山一帶的 AMeDAS 站(fetch_jma,抓不到就略過,不影響 CWA)
→ data/stations/{stamp}.json(所有變數一個檔,前端切換變數不用重抓)
過去 1/2/3/6 小時最大最小 → data/stations/agg_{N}h/{stamp}.json(station_agg)
並用同一批雨量做 IDW → data/rain/idw/{acc}/{stamp}.bin.gz。"""
from .common import check_update, fetch_cwa, log, save_points, twd67_to_wgs84, utc_stamp
from . import config, fetch_jma, idw, station_agg, station_recent, station_series

LAYER = "stations"

# 輸出欄位(順序即 rows 每列的順序)
META_FIELDS = ["id", "name", "lon", "lat", "alt", "county", "town", "obs", "type"]   # type:manned 局屬 / auto 自動 / rain 雨量
WX_FIELDS = ["temp", "rh", "pres", "ws", "wd", "gust", "gust_dir", "tmax", "tmin"]
EXTRA_FIELDS = ["gust_at",              # 陣風(gust)的發生時間
                "gust_day", "gust_t",   # 當日最大陣風與發生時間(只有日本氣象廳站有,見 fetch_jma)
                "wx10"]                 # 1 = 氣象要素 10 分鐘一筆(O-A0003-001 的站、日本氣象廳站)
RAIN_FIELDS = [f"rain_{k}" for k in config.RAIN_ACC]
FIELDS = META_FIELDS + WX_FIELDS + RAIN_FIELDS + EXTRA_FIELDS


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
    c = st["GeoInfo"]["Coordinates"][0]          # 沒有 WGS84 才自己轉
    return twd67_to_wgs84(float(c["StationLongitude"]), float(c["StationLatitude"]))


def _base(st):
    lon, lat = _wgs84(st)
    g = st["GeoInfo"]
    return {"id": st["StationId"], "name": st["StationName"], "lon": round(lon, 5),
            "lat": round(lat, 5), "alt": _num(g.get("StationAltitude"), True),
            "county": g.get("CountyName"), "town": g.get("TownName"),
            "obs": utc_stamp(st["ObsTime"]["DateTime"])}


def _at(iso):
    try:
        return utc_stamp(iso) if iso else None
    except ValueError:
        return None


def _wx(w):
    return dict(temp=_num(w.get("AirTemperature"), True), rh=_num(w.get("RelativeHumidity")),
                pres=_num(w.get("AirPressure")), ws=_num(w.get("WindSpeed")), wd=_num(w.get("WindDirection")))


def collect():
    """O-A0001-001(876 站,整點)與 O-A0003-001(其中 363 站,10 分鐘)合併:
    溫度、濕度、氣壓、風取兩者中觀測時間較新的那筆,obs 用那筆的時間,這些站標 wx10(時序圖 10 分鐘);
    陣風、今日高低溫一律取 O-A0001-001 —— O-A0003-001 的陣風是「上一個整點小時內最大」,
    16:50 那筆給的是 15–16 時,和觀測時間對不上。"""
    sta = {}
    for st in fetch_cwa("O-A0001-001")["dataset"]["Station"]:
        w = st["WeatherElement"]
        rec = sta.setdefault(st["StationId"], _base(st))
        rec["type"] = "manned" if st["StationId"].startswith("46") else "auto"   # 46 開頭 = 局屬站
        rec.update(
            _wx(w),
            gust=_num(_get(w, "GustInfo", "PeakGustSpeed")),
            gust_dir=_num(_get(w, "GustInfo", "Occurred_at", "WindDirection")),
            gust_at=_at(_get(w, "GustInfo", "Occurred_at", "DateTime")),
            tmax=_num(_get(w, "DailyExtreme", "DailyHigh", "TemperatureInfo", "AirTemperature"), True),
            tmin=_num(_get(w, "DailyExtreme", "DailyLow", "TemperatureInfo", "AirTemperature"), True),
        )
    for st in fetch_cwa("O-A0003-001")["dataset"]["Station"]:
        sid, obs = st["StationId"], utc_stamp(st["ObsTime"]["DateTime"])
        rec = sta.get(sid)
        if rec is None:
            rec = sta[sid] = _base(st)
            rec["type"] = "manned" if sid.startswith("46") else "auto"
        rec["wx10"] = 1
        if obs >= (rec.get("obs") or ""):
            rec.update(_wx(st["WeatherElement"]), obs=obs)
    for rec in sta.values():
        if rec.get("temp") is not None and rec["temp"] < -50:
            rec["temp"] = None

    rain_times = []
    for st in fetch_cwa("O-A0002-001")["dataset"]["Station"]:
        rec = sta.setdefault(st["StationId"], _base(st))
        rec.setdefault("type", "rain")
        rain_times.append(st["ObsTime"]["DateTime"])
        for acc, key in config.RAIN_ACC.items():
            rec[f"rain_{acc}"] = _num(_get(st, "RainfallElement", key, "Precipitation"))

    # 檔名時間 = 雨量站最新觀測時間(10 分鐘一筆)
    stamp = utc_stamp(max(rain_times))
    recs = list(sta.values())
    try:
        recs += fetch_jma.collect(stamp)
    except Exception as e:
        log.warning("jma 測站抓取失敗,這次略過:%s", e)
    return stamp, recs


def run():
    stamp, recs = collect()
    status, prev = check_update(LAYER, stamp, ".json")
    if status != "new":
        return status, stamp, prev
    rows = [[r.get(f) for f in FIELDS] for r in recs]
    snapshot = {"time": stamp, "fields": FIELDS, "rows": rows}
    save_points(LAYER, stamp, snapshot,
                fields=FIELDS, source="CWA O-A0001-001 / O-A0003-001 / O-A0002-001;気象庁 AMeDAS")
    log.info("stations %s 完成(%d 站)", stamp, len(rows))
    station_series.append(snapshot)
    station_agg.run(stamp)
    station_recent.run(snapshot)
    idw.run(stamp, [r for r in recs if r.get("type") != "jma"])   # IDW 只用台灣測站
    return status, stamp, prev


if __name__ == "__main__":
    print(run())

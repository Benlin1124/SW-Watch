"""日本氣象廳 AMeDAS 測站(宮古、八重山一帶),併進 stations 快照。
來源是氣象廳官網アメダス頁面用的 JSON(非正式 API,格式可能不另行通知就改;出典：気象庁):
  測站表 bosai/amedas/const/amedastable.json(快取一天)
  全國同一時刻 bosai/amedas/data/map/{JST YYYYMMDDHHmm00}.json(10 分鐘一檔)
陣風只在單站檔 point/{code}/{JST YYYYMMDD_HH}.json(3 小時一檔),而且是日本時間當日 00 時起的最大值與發生時間:
  gust     只有發生時間在觀測前 1 小時內才填(和 CWA PeakGustSpeed「過去 1 小時最大」同義),否則留空
  gust_day 當日最大陣風(不管多久以前發生都填,日本時間 00 時歸零)
  gust_t   當日最大的發生時間(UTC stamp);station_agg 用 gust_day + gust_t 算「過去 N 小時最大」
當日最高最低溫的日界和 CWA 差 1 小時,留空。"""
import json
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import requests

from . import config
from .common import log

BASE = "https://www.jma.go.jp/bosai/amedas"
JST = timezone(timedelta(hours=9))
TABLE_CACHE = config.CACHE_DIR / "jma_amedastable.json"
AREA = config.JMA_AREA
# 測站代碼前兩碼 → (縣, 地區);範圍內只有這幾區
REGION = {"88": ("日本鹿兒島縣", "奄美"), "91": ("日本沖繩縣", "沖繩本島"),
          "93": ("日本沖繩縣", "宮古"), "94": ("日本沖繩縣", "八重山")}


def _json(url):
    r = requests.get(url, timeout=30)
    r.raise_for_status()
    return r.json()


def _table():
    if TABLE_CACHE.exists() and time.time() - TABLE_CACHE.stat().st_mtime < 86400:
        return json.loads(TABLE_CACHE.read_text(encoding="utf-8"))
    t = _json(f"{BASE}/const/amedastable.json")
    TABLE_CACHE.parent.mkdir(parents=True, exist_ok=True)
    TABLE_CACHE.write_text(json.dumps(t, ensure_ascii=False), encoding="utf-8")
    return t


def _deg(dm):
    return round(dm[0] + dm[1] / 60, 5)


def _val(d, key):
    """[值, 品質旗標];0 正常、1 準正常可用,其他視為缺測。"""
    v = d.get(key)
    if not v or v[0] is None or v[1] not in (0, 1):
        return None
    return float(v[0])


def _map(stamp):
    """取和 CWA 同一時刻(UTC stamp)的 map 檔;還沒出來就退回氣象廳最新一筆(不晚於 stamp)。"""
    want = datetime.strptime(stamp, "%Y%m%d%H%M").replace(tzinfo=timezone.utc).astimezone(JST)
    try:
        return want, _json(f"{BASE}/data/map/{want:%Y%m%d%H%M}00.json")
    except requests.HTTPError:
        latest = datetime.fromisoformat(requests.get(f"{BASE}/data/latest_time.txt", timeout=30).text.strip())
        t = min(latest, want)
        return t, _json(f"{BASE}/data/map/{t:%Y%m%d%H%M}00.json")


def _dir(code):
    """16 方位碼 → 度:1 = 北北東 … 16 = 北,0 = 靜風。"""
    return None if code is None else (0.0 if code == 0 else code * 22.5)


def _gust(code, t):
    """單站檔裡 t 那筆的當日最大陣風 → (值, 風向, 發生時間 JST);抓不到回傳 None。"""
    try:
        blk = t.replace(hour=t.hour // 3 * 3, minute=0)
        d = _json(f"{BASE}/data/point/{code}/{blk:%Y%m%d_%H}.json").get(f"{t:%Y%m%d%H%M}00", {})
    except Exception:
        return None
    v, gt = _val(d, "gust"), d.get("gustTime")
    if v is None or not gt:
        return None
    g = t.replace(hour=0, minute=0) + timedelta(hours=gt["hour"], minutes=gt["minute"])
    if g > t:                                            # 00:00 那筆是前一天的總結
        g -= timedelta(days=1)
    return v, _dir(_val(d, "gustDirection")), g


def collect(stamp):
    """回傳和 fetch_stations 同格式的測站紀錄(type='jma',id 前綴 J)。"""
    table = _table()
    t, data = _map(stamp)
    obs = t.astimezone(timezone.utc).strftime("%Y%m%d%H%M")
    recs, wind_codes = [], []
    for code, st in table.items():
        lon, lat = _deg(st["lon"]), _deg(st["lat"])
        if not (AREA[0] <= lon <= AREA[2] and AREA[1] <= lat <= AREA[3]):
            continue
        d = data.get(code)
        if not d:
            continue
        county, town = REGION.get(code[:2], ("日本", ""))
        if "wind" in d:
            wind_codes.append(code)
        recs.append({
            "id": f"J{code}", "name": st["kjName"], "lon": lon, "lat": lat, "alt": st.get("alt"),
            "county": county, "town": town, "obs": obs, "type": "jma",
            "temp": _val(d, "temp"), "rh": _val(d, "humidity"), "pres": _val(d, "pressure"),
            "ws": _val(d, "wind"), "wd": _dir(_val(d, "windDirection")),
            "gust": None, "gust_dir": None, "gust_day": None, "gust_t": None, "tmax": None, "tmin": None,
            "rain_10m": _val(d, "precipitation10m"), "rain_1h": _val(d, "precipitation1h"),
            "rain_3h": _val(d, "precipitation3h"), "rain_24h": _val(d, "precipitation24h"),
        })
    with ThreadPoolExecutor(8) as ex:
        gusts = dict(zip(wind_codes, ex.map(lambda c: _gust(c, t), wind_codes)))
    by_id = {r["id"]: r for r in recs}
    for code, g in gusts.items():
        if g is None:
            continue
        v, gd, gt = g
        r = by_id[f"J{code}"]
        r["gust_day"], r["gust_t"] = v, gt.astimezone(timezone.utc).strftime("%Y%m%d%H%M")
        if t - gt <= timedelta(hours=1):
            r["gust"], r["gust_dir"] = v, gd
    log.info("jma %s JST:%d 站(陣風 %d 站)", f"{t:%m/%d %H:%M}", len(recs), sum(g is not None for g in gusts.values()))
    return recs


if __name__ == "__main__":
    now = datetime.now(timezone.utc) - timedelta(minutes=20)
    for r in collect(now.strftime("%Y%m%d%H") + f"{now.minute // 10 * 10:02d}"):
        print(r)

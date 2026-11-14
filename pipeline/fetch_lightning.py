"""氣象署即時閃電(O-A0039-001):過去 1 小時每一筆閃電(時間到分、經緯度、雲間 / 對地)
  → data/lightning/{10 分鐘格}.json   {"s": [[經度, 緯度, 格內第幾分 0–9, 種類 0 = 雲間 / 1 = 對地], ...]}
  index.json:times = 已有的格(沒有閃電的格也存空的,才分得出「沒打雷」和「沒資料」);
             end = 來源涵蓋到的時間(不含),例如 16:00~17:00 → 17:00(UTC stamp)。
來源:cwaopendata S3 公開網址 Observation/O-A0039-001.kmz(約 10–100 KB),不計會員次數。
  KMZ 裡的 doc.kml:<Document><name> 寫涵蓋時段(台灣時間),每個 Placemark 一筆閃電。
每次抓完把來源涵蓋的格整格重寫(來源晚到的閃電也會補上);內容沒變的格不重寫(少上傳)。
手動:python -m pipeline.fetch_lightning"""
import hashlib
import io
import json
import re
import zipfile
from datetime import datetime, timedelta, timezone

import requests

from .common import _io_lock, layer_dir, log, read_index, save_json, update_index

LAYER = "lightning"
URL = "https://cwaopendata.s3.ap-northeast-1.amazonaws.com/Observation/O-A0039-001.kmz"
TW = timezone(timedelta(hours=8))
STEP = 10
session = requests.Session()

_SPAN = re.compile(r"<name>[^<]*?(\d{4}-\d\d-\d\d \d\d:\d\d)\s*~\s*(\d{4}-\d\d-\d\d \d\d:\d\d)</name>")
_MARK = re.compile(r"<Placemark>.*?<name>(雲間|對地)閃電.*?<when>([^<]+?)\s*</when\s*>.*?<coordinates>([^<]+)</coordinates>", re.S)


def _tw(s):
    return datetime.strptime(s, "%Y-%m-%d %H:%M").replace(tzinfo=TW).astimezone(timezone.utc)


def _stamp(dt):
    return dt.strftime("%Y%m%d%H%M")


def parse(kml):
    """→ (涵蓋起點, 涵蓋終點(不含), [(UTC datetime, 經度, 緯度, 種類)])"""
    m = _SPAN.search(kml)
    if not m:
        raise ValueError("找不到閃電資料的涵蓋時段")
    start, end = _tw(m.group(1)), _tw(m.group(2))
    out = []
    for kind, when, coord in _MARK.findall(kml):
        t = datetime.strptime(when.strip()[:16], "%Y-%m-%dT%H:%M").replace(tzinfo=timezone.utc)
        lon, lat = (float(x) for x in coord.split(",")[:2])
        out.append((t, round(lon, 3), round(lat, 3), 1 if kind == "對地" else 0))
    return start, end, out


def floor_slot(dt):
    return dt.replace(minute=dt.minute - dt.minute % STEP, second=0, microsecond=0)


def run():
    raw = session.get(URL, timeout=60)
    raw.raise_for_status()
    digest = hashlib.md5(raw.content).hexdigest()
    idx = read_index(LAYER)
    prev = idx.get("end")
    if idx.get("md5") == digest:
        return "same", prev, prev
    kml = zipfile.ZipFile(io.BytesIO(raw.content)).read("doc.kml").decode("utf-8")
    start, end, strikes = parse(kml)
    end_s = _stamp(end)
    if prev and end_s < prev:
        return "older", end_s, prev

    # 涵蓋時段內的每一格(起點不在整 10 分時,第一格不完整 → 不動它,避免蓋掉上一輪較完整的)
    slots = {}
    t = floor_slot(start)
    if t < start:
        t += timedelta(minutes=STEP)
    while t < end:
        slots[t] = []
        t += timedelta(minutes=STEP)
    for when, lon, lat, kind in strikes:
        s = floor_slot(when)
        if s in slots:
            slots[s].append([lon, lat, when.minute % STEP, kind])

    written = []
    for s, rows in slots.items():
        rows.sort(key=lambda r: (r[2], r[3], r[0], r[1]))
        stamp = _stamp(s)
        path = layer_dir(LAYER) / f"{stamp}.json"
        obj = {"s": rows}
        if path.exists() and stamp in idx["times"]:
            try:
                if json.loads(path.read_text(encoding="utf-8")) == obj:
                    continue
            except ValueError:
                pass
        save_json(path, obj)
        written.append(stamp)
    with _io_lock:
        for stamp in written:
            update_index(LAYER, stamp, source="CWA O-A0039-001", name="即時閃電")
        idx = read_index(LAYER)
        idx.update(end=end_s, md5=digest)
        save_json(layer_dir(LAYER) / "index.json", idx)
    log.info("閃電 %s~%s:%d 筆(對地 %d),重寫 %d 格", _stamp(start), end_s, len(strikes),
             sum(r[3] for r in strikes), len(written))
    return ("new" if end_s != prev or written else "same"), end_s, prev


if __name__ == "__main__":
    import logging
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    print(run())

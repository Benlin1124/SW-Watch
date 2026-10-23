"""CWA 颱風消息 W-C0034-005 → 原始 JSON 歸檔 data/typhoon/cwa/{stamp}.json.gz
並轉成前端格式 data/typhoon/cwa_track/{stamp}.json(見 typhoon_cwa.py)。"""
import time

from . import typhoon_cwa
from .common import check_update, fetch_cwa, layer_dir, log, save_json, update_index, utc_stamp

LAYER = "typhoon/cwa"
WARN_TTL_SEC = 300
_warn = {"at": 0, "kind": None}


def _list(x):
    return x if isinstance(x, list) else ([x] if x else [])


def warning():
    """目前的颱風警報(W-C0033-002 天氣特報):'海上陸上'、'海上'、''(沒有警報);抓不到又沒有前次結果回傳 None。
    結果快取 5 分鐘;條件式請求,沒更新不耗流量。"""
    if time.time() - _warn["at"] < WARN_TTL_SEC:
        return _warn["kind"]
    try:
        od = fetch_cwa("W-C0033-002")
        kind = ""
        for ds in _list(od.get("dataset")):
            hz = _list(((ds.get("hazardConditions") or {}).get("hazards") or {}).get("hazard"))
            if any((h.get("info") or {}).get("phenomena") == "颱風" for h in hz):
                desc = (ds.get("datasetInfo") or {}).get("datasetDescription") or ""
                kind = "海上陸上" if "陸上" in desc else "海上"
    except Exception as e:
        log.warning("颱風警報狀態抓取失敗:%s", e)
        _warn["at"] = time.time() - WARN_TTL_SEC + 60          # 1 分鐘後再試,先沿用前次結果
        return _warn["kind"]
    if kind != _warn["kind"]:
        log.info("颱風警報狀態:%s", kind + "颱風警報" if kind else "無")
    _warn.update(at=time.time(), kind=kind)
    return kind


def run():
    od = fetch_cwa("W-C0034-005")
    stamp = utc_stamp(od["Sent"])
    status, prev = check_update(LAYER, stamp, ".json.gz")
    if status != "new":
        return status, stamp, prev
    save_json(layer_dir(LAYER) / f"{stamp}.json.gz", od, gz=True)
    tcs = (od.get("Dataset") or {}).get("TropicalCyclones") or {}
    tc = tcs.get("TropicalCyclone") or []
    tc = tc if isinstance(tc, list) else [tc]
    names = [f'{t.get("CwaTyphoonName") or ""}({t.get("TyphoonName") or ""})' for t in tc]
    update_index(LAYER, stamp, source="CWA W-C0034-005", format="raw-json-gz")
    typhoon_cwa.save(od)
    log.info("typhoon cwa %s 完成:%s", stamp, "、".join(names) or "目前無颱風")
    return status, stamp, prev


if __name__ == "__main__":
    print(run())

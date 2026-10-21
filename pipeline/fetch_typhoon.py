"""CWA 颱風消息 W-C0034-005 → 原始 JSON 歸檔 data/typhoon/cwa/{stamp}.json.gz。
API 只給最新一筆,所以先完整存檔;前端用的精簡格式在 Phase 4 再從歸檔轉出。"""
from .common import check_update, fetch_cwa, layer_dir, log, save_json, update_index, utc_stamp

LAYER = "typhoon/cwa"


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
    log.info("typhoon cwa %s 完成:%s", stamp, "、".join(names) or "目前無颱風")
    return status, stamp, prev


if __name__ == "__main__":
    print(run())

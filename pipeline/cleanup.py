"""保留策略:測站、雷達、雨量等資料保留 KEEP_DAYS 天(預設 10),更舊的全刪(事件要永久保留用 event_archive);
颱風資料永久保留;衛星只留 SAT_KEEP_DAYS 天;ECMWF、氣象署 WRF / 海浪只留 ECMWF_KEEP_DAYS 天;各站月 CSV(stations/series)永久保留。"""
import json
from datetime import datetime, timedelta, timezone

from . import config
from .common import log, remove, save_json
from .fetch_cwa_wave import cleanup as cleanup_cwawave
from .fetch_ecmwf import cleanup as cleanup_ecmwf
from .fetch_satellite import cleanup as cleanup_satellite
from .fetch_wrf import cleanup as cleanup_wrf
from .station_series import compress_old_months

SKIP = ("typhoon", "ecmwf", "wrf", "cwawave")


def run():
    cutoff = (datetime.now(timezone.utc) - timedelta(days=config.KEEP_DAYS)).strftime("%Y%m%d%H%M")
    for idx_path in config.DATA_DIR.rglob("index.json"):
        rel = idx_path.parent.relative_to(config.DATA_DIR).as_posix()
        if rel.startswith(SKIP):
            continue
        idx = json.loads(idx_path.read_text(encoding="utf-8"))
        drop = [t for t in idx["times"] if t < cutoff]
        if not drop:
            continue
        for t in drop:
            for f in idx_path.parent.glob(f"{t}.*"):
                remove(f)
        idx["times"] = [t for t in idx["times"] if t not in set(drop)]
        idx["fetched"] = {t: v for t, v in idx.get("fetched", {}).items() if t not in set(drop)}
        save_json(idx_path, idx)
        log.info("cleanup %s:刪除 %d 筆", rel, len(drop))
    compress_old_months()
    cleanup_satellite()
    cleanup_ecmwf()
    cleanup_wrf()
    cleanup_cwawave()


if __name__ == "__main__":
    run()

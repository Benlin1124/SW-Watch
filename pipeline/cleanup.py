"""保留策略:10 分鐘資料保留 KEEP_FULL_DAYS 天,更舊的只留整點;颱風資料永久保留。"""
import json
from datetime import datetime, timedelta, timezone

from . import config
from .common import log, save_json

SKIP = ("typhoon",)


def run():
    cutoff = (datetime.now(timezone.utc) - timedelta(days=config.KEEP_FULL_DAYS)).strftime("%Y%m%d%H%M")
    for idx_path in config.DATA_DIR.rglob("index.json"):
        rel = idx_path.parent.relative_to(config.DATA_DIR).as_posix()
        if rel.startswith(SKIP):
            continue
        idx = json.loads(idx_path.read_text(encoding="utf-8"))
        drop = [t for t in idx["times"] if t < cutoff and not t.endswith("00")]
        if not drop:
            continue
        for t in drop:
            for f in idx_path.parent.glob(f"{t}.*"):
                f.unlink()
        idx["times"] = [t for t in idx["times"] if t not in set(drop)]
        save_json(idx_path, idx)
        log.info("cleanup %s:刪除 %d 筆", rel, len(drop))


if __name__ == "__main__":
    run()

"""本機常駐排程(之後搬到樹莓派也一樣):python -m pipeline.scheduler
單次全部跑一輪:python -m pipeline.scheduler --once

擷取窗口:每個週期內從第 1 分鐘起每分鐘檢查一次(S3 條件式請求,沒更新不耗流量),
抓到新資料就停到下一個週期;到窗口最後一分鐘仍未更新 → 記為 missed。
10 分鐘產品窗口是每輪第 1–9 分(第 9 分前一定要擷取到)。
每次檢查都和上一筆比較,寫進 data/status.json 與 logs/fetch_history.csv。"""
import argparse
import logging
from datetime import datetime, timezone
from logging.handlers import TimedRotatingFileHandler

from apscheduler.schedulers.blocking import BlockingScheduler

from . import cleanup, config, fetch_radar, fetch_rain_grid, fetch_stations, fetch_typhoon
from .common import read_status, record_status, stamp_dt

log = logging.getLogger("pipeline")


def window(cycle, first, last):
    """週期 cycle 分鐘內第 first–last 分 → cron minute 字串,例如 (10, 1, 9) → '1-9,11-19,…'。"""
    return ",".join(f"{s + first}-{s + last}" for s in range(0, 60, cycle))


# (名稱, 函式, cron 參數, 週期分鐘, 窗口最後一分)
# 週期 None = 不定期產品:每次都檢查(條件式請求不耗流量),不做「本輪已抓到」判斷
JOBS = [
    ("radar", fetch_radar.run, dict(minute=window(10, 1, 9)), 10, 9),
    ("stations", fetch_stations.run, dict(minute=window(10, 1, 9)), 10, 9),
    ("qpe1h", fetch_rain_grid.run_qpe1h, dict(minute=window(10, 1, 9)), 10, 9),
    ("rain_today", fetch_rain_grid.run_daily, dict(minute=window(30, 1, 15)), 30, 15),
    # 颱風消息:台灣 02/08/14/20 時發布、延後 1–2 小時上架 → UTC 19–20、01–02、07–08、13–14 時每 5 分檢查;
    # 其他時段每小時檢查一次(警報期間可能加發)
    ("typhoon_cwa", fetch_typhoon.run, dict(minute="*/5", hour="1,2,7,8,13,14,19,20"), None, None),
    ("typhoon_cwa_hourly", fetch_typhoon.run,
     dict(minute="30", hour="0,3,4,5,6,9,10,11,12,15,16,17,18,21,22,23"), None, None),
]


def setup_logging():
    config.LOG_DIR.mkdir(parents=True, exist_ok=True)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    fh = TimedRotatingFileHandler(config.LOG_DIR / "pipeline.log", when="midnight",
                                  backupCount=14, encoding="utf-8")
    sh = logging.StreamHandler()
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    for h in (fh, sh):
        h.setFormatter(fmt)
        root.addHandler(h)
    logging.getLogger("apscheduler").setLevel(logging.WARNING)


def make_job(name, fn, cycle, last):
    status_name = name.replace("_hourly", "")

    def job(force=False):
        now = datetime.now(timezone.utc)
        attempt = 0
        if cycle:
            cycle_start = now.replace(minute=now.minute - now.minute % cycle, second=0, microsecond=0)
            st = read_status(status_name)
            if not force and st.get("last_new") and stamp_dt(st["last_new"]) >= cycle_start:
                return                                    # 本輪已抓到新資料
            attempt = now.minute % cycle - 1              # 窗口內第幾次嘗試(0 起算)

        stamp = prev = error = None
        try:
            status, stamp, prev = fn()
        except Exception as e:
            status, error = "error", f"{type(e).__name__}: {e}"
            log.exception("%s 失敗", name)
        if force:
            attempt = 0                                   # 啟動時強制跑的那一次不算窗口內嘗試
        elif cycle and status in ("same", "error") and now.minute % cycle >= last:
            log.warning("%s 第 %d 分仍未擷取到新資料(%s)", name, last, status)
            if status == "same":
                status = "missed"
        if status == "older":
            log.warning("%s 資料時間 %s 比上一筆 %s 舊,略過", name, stamp, prev)
        record_status(status_name, status, stamp, prev, max(attempt, 0), error)
    return job


def safe_cleanup():
    try:
        cleanup.run()
    except Exception:
        log.exception("cleanup 失敗")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true", help="每個工作各跑一次就結束")
    args = ap.parse_args()
    setup_logging()

    jobs = [(name, make_job(name, fn, cycle, last), cron)
            for name, fn, cron, cycle, last in JOBS]
    if args.once:
        for name, job, _ in jobs:
            if not name.endswith("_hourly"):
                job(force=True)
        return

    sched = BlockingScheduler(timezone="UTC")
    for name, job, cron in jobs:
        sched.add_job(job, "cron", id=name, max_instances=1, coalesce=True,
                      misfire_grace_time=50, **cron)
    sched.add_job(safe_cleanup, "cron", hour=19, minute=30, id="cleanup")  # 台灣 03:30
    for name, job, _ in jobs:          # 啟動時先跑一輪
        if not name.endswith("_hourly"):
            sched.add_job(job, "date", run_date=datetime.now(timezone.utc),
                          kwargs={"force": True}, id=f"{name}_start")
    log.info("排程啟動")
    sched.start()


if __name__ == "__main__":
    main()

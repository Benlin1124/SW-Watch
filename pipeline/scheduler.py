"""本機常駐排程(之後搬到樹莓派也一樣):python -m pipeline.scheduler
單次全部跑一輪:python -m pipeline.scheduler --once

每次抓取都和上一筆比較(common.check_update),結果寫進 data/status.json 與 logs/fetch_history.csv。
失敗,或資料逾時未更新(late)→ RETRY_DELAY_SEC(1 分鐘)後重試,最多 max_retry 次。
「逾時」= 現在 ≥ 上一筆資料時間 + 更新間隔 + 上架延遲;還沒到下一筆該出現的時間就不重試,省 API 次數。"""
import argparse
import logging
from datetime import datetime, timedelta, timezone
from logging.handlers import TimedRotatingFileHandler

from apscheduler.schedulers.blocking import BlockingScheduler

from . import cleanup, config, fetch_radar, fetch_rain_grid, fetch_stations, fetch_typhoon
from .common import record_status, stamp_dt

log = logging.getLogger("pipeline")

# (名稱, 函式, cron 分鐘, 最多重試次數, 更新間隔分鐘, 上架延遲分鐘)
# 上架延遲是初估值,之後依 logs/fetch_history.csv 的 delay_min 調整;
# 10 分鐘產品最多重試 5 次,剛好不會撞到下一輪。間隔 None = 不定期(颱風),只在出錯時重試
JOBS = [
    ("radar", fetch_radar.run, "4,14,24,34,44,54", 5, 10, 3),
    ("stations", fetch_stations.run, "5,15,25,35,45,55", 5, 10, 3),
    ("qpe1h", fetch_rain_grid.run_qpe1h, "6,16,26,36,46,56", 5, 10, 15),
    ("rain_today", fetch_rain_grid.run_daily, "8,38", 20, 30, 5),
    ("typhoon_cwa", fetch_typhoon.run, "10,40", 5, None, None),
]

sched = None


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


def make_job(name, fn, max_retry, interval, lag):
    def job(attempt=0):
        stamp = prev = error = None
        try:
            status, stamp, prev = fn()
        except Exception as e:
            status, error = "error", f"{type(e).__name__}: {e}"
            log.exception("%s 失敗(第 %d 次)", name, attempt + 1)
        if status == "same" and interval and stamp:
            due = stamp_dt(stamp) + timedelta(minutes=interval + lag)
            if datetime.now(timezone.utc) >= due:
                status = "late"      # 下一筆早該出現卻還沒更新
        record_status(name, status, stamp, prev, attempt, error)

        if status == "older":
            log.warning("%s 資料時間 %s 比上一筆 %s 舊,略過", name, stamp, prev)
        retry = status in ("error", "late")
        if retry and sched is not None and attempt < max_retry:
            run_at = datetime.now(timezone.utc) + timedelta(seconds=config.RETRY_DELAY_SEC)
            sched.add_job(job, "date", run_date=run_at, args=[attempt + 1],
                          id=f"{name}_retry", replace_existing=True)
            log.info("%s %s,%d 秒後重試(%d/%d)", name, status, config.RETRY_DELAY_SEC,
                     attempt + 1, max_retry)
    return job


def safe_cleanup():
    try:
        cleanup.run()
    except Exception:
        log.exception("cleanup 失敗")


def main():
    global sched
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true", help="每個工作各跑一次就結束(不重試)")
    args = ap.parse_args()
    setup_logging()

    jobs = [(name, make_job(name, fn, mr, iv, lag), minutes) for name, fn, minutes, mr, iv, lag in JOBS]
    if args.once:
        for _, job, _ in jobs:
            job()
        return

    sched = BlockingScheduler(timezone="UTC")
    for name, job, minutes in jobs:
        # 正規排程到了就取消尚未執行的重試,避免同一資料重複請求
        def regular(job=job, name=name):
            if sched.get_job(f"{name}_retry"):
                sched.remove_job(f"{name}_retry")
            job()
        sched.add_job(regular, "cron", minute=minutes, id=name,
                      max_instances=1, coalesce=True, misfire_grace_time=300)
    sched.add_job(safe_cleanup, "cron", hour=19, minute=30, id="cleanup")  # 台灣 03:30
    for name, job, _ in jobs:          # 啟動時先跑一輪(之後的重試照常排程)
        sched.add_job(job, "date", run_date=datetime.now(timezone.utc), id=f"{name}_start")
    log.info("排程啟動")
    sched.start()


if __name__ == "__main__":
    main()

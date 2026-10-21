"""本機常駐排程(之後搬到樹莓派也一樣):python -m pipeline.scheduler
單次全部跑一輪:python -m pipeline.scheduler --once"""
import argparse
import logging
from logging.handlers import TimedRotatingFileHandler

from apscheduler.schedulers.blocking import BlockingScheduler

from . import cleanup, config, fetch_radar, fetch_rain_grid, fetch_stations, fetch_typhoon

# (名稱, 函式, cron 分鐘);CWA 資料約在整 10 分後 2–5 分鐘上架,所以錯開抓
JOBS = [
    ("radar", fetch_radar.run, "4,14,24,34,44,54"),
    ("stations", fetch_stations.run, "5,15,25,35,45,55"),
    ("qpe1h", fetch_rain_grid.run_qpe1h, "6,16,26,36,46,56"),
    ("rain_today", fetch_rain_grid.run_daily, "8,38"),
    ("typhoon_cwa", fetch_typhoon.run, "10,40"),
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


def safe(name, fn):
    def wrapper():
        try:
            fn()
        except Exception:
            logging.getLogger("pipeline").exception("%s 失敗", name)
    return wrapper


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true", help="每個工作各跑一次就結束")
    args = ap.parse_args()
    setup_logging()

    if args.once:
        for name, fn, _ in JOBS:
            safe(name, fn)()
        return

    sched = BlockingScheduler(timezone="UTC")
    for name, fn, minutes in JOBS:
        sched.add_job(safe(name, fn), "cron", minute=minutes, id=name,
                      max_instances=1, coalesce=True, misfire_grace_time=300)
    sched.add_job(safe("cleanup", cleanup.run), "cron", hour=19, minute=30, id="cleanup")  # 台灣 03:30
    for name, fn, _ in JOBS:          # 啟動時先跑一輪
        safe(name, fn)()
    logging.getLogger("pipeline").info("排程啟動")
    sched.start()


if __name__ == "__main__":
    main()

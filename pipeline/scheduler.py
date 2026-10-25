"""本機常駐排程(之後搬到樹莓派也一樣):python -m pipeline.scheduler
單次全部跑一輪:python -m pipeline.scheduler --once

擷取窗口:每個週期內從第 1 分鐘起每分鐘檢查一次(S3 條件式請求,沒更新不耗流量),
抓到新資料就停到下一個週期;到窗口最後一分鐘仍未更新 → 記為 missed。
10 分鐘產品窗口是每輪第 1–9 分(第 9 分前一定要擷取到)。
每次檢查都和上一筆比較,寫進 data/status.json 與 logs/fetch_history.csv。"""
import argparse
import logging
import os
import threading
import warnings
from datetime import datetime, timezone
from logging.handlers import TimedRotatingFileHandler

from apscheduler.schedulers.blocking import BlockingScheduler

from . import (cleanup, config, fetch_ecmwf, fetch_ensemble, fetch_marine, fetch_radar, fetch_rain_grid, fetch_satellite,
               fetch_stations, fetch_typhoon, r2)
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
    # 海象(每小時一筆,約整點後 20–40 分上架):REST 沒有條件式請求,每 5 分檢查一次,平常只抓最近 4 小時
    ("marine", fetch_marine.run, dict(minute="5-55/5"), 60, 55),
    # 颱風消息:每分鐘觸發,由 typhoon_due() 決定這一分鐘要不要真的去抓(見下方說明)
    ("typhoon_cwa", fetch_typhoon.run, dict(minute="*"), None, None),
]


def typhoon_due(now):
    """颱風消息 W-C0034-005 這一分鐘要不要檢查(UTC;條件式請求沒更新不耗流量)。
    依 W-C0033-002 判斷目前有沒有颱風警報(fetch_typhoon.warning,5 分鐘查一次):
    1. 有警報(海上或海上陸上):每小時都會更新最新位置(約整點後 15–25 分上架,例如 19:15 發布 19:00 位置),
       每 3 小時的警報(台灣 02:30、05:30…)前後也會更新 → 每小時 :10–:50 每分鐘檢查,其餘每 5 分
    2. 沒有警報:一天 4 次(台灣 02/08/14/20 時)發布、延後 1–2 小時上架 → 每 5 分檢查
    3. 警報狀態抓不到:照警報時段(UTC 每 3 小時的 :20–:50)每分鐘檢查,其餘每 5 分"""
    kind = fetch_typhoon.warning()
    if kind and 10 <= now.minute <= 50:
        return True
    if kind is None and now.hour % 3 == 0 and 20 <= now.minute <= 50:
        return True
    return now.minute % 5 == 0


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
    # 衛星套件的一般訊息(BZ2 解壓暫存檔、太空背景算 log 的 NaN 警告)不寫進 log
    logging.getLogger("satpy").setLevel(logging.WARNING)
    warnings.filterwarnings("ignore", message="invalid value encountered", category=RuntimeWarning)
    # 衛星 B03 一筆要 1–2 分鐘,期間每分鐘的觸發被略過是預期的,不寫進 log
    logging.getLogger("apscheduler.scheduler").addFilter(
        lambda r: not ("safe_satellite" in r.getMessage() and "maximum number of running instances" in r.getMessage()))


def make_job(name, fn, cycle, last):
    status_name = name

    def job(force=False):
        now = datetime.now(timezone.utc)
        if name == "typhoon_cwa" and not force and not typhoon_due(now):
            return
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


def safe_ensemble():
    """系集路徑:每 15 分檢查 00/06/12/18Z 初始時間後 1–12 小時內還沒抓到的模式(狀態由 fetch_ensemble 自己記)。"""
    try:
        got = fetch_ensemble.run()
        if got:
            log.info("系集新資料:%s", "、".join(got))
    except Exception:
        log.exception("ensemble 失敗")


def safe_satellite():
    """衛星:每分鐘檢查最近 SAT_WAIT_MIN 分鐘內還沒處理的時次(AWS 免費、不計氣象署額度;狀態由 fetch_satellite 自己記)。"""
    try:
        fetch_satellite.run()
    except Exception:
        log.exception("satellite 失敗")


_ecmwf_lock = threading.Lock()


def safe_ecmwf():
    """ECMWF 預報:每 10 分檢查 00/12Z 起報(起報後約 7–8 小時上架);一報下載約 400 MB、數分鐘。
    啟動時那一次和定時的是不同工作,用鎖避免同時跑兩個。"""
    if not _ecmwf_lock.acquire(blocking=False):
        return
    try:
        status, stamp, prev = fetch_ecmwf.run()
        if status == "new":
            record_status("ecmwf", status, stamp, prev)
    except Exception as e:
        log.exception("ecmwf 失敗")
        record_status("ecmwf", "error", error=f"{type(e).__name__}: {e}")
    finally:
        _ecmwf_lock.release()


def safe_r2_flush():
    try:
        n, d = r2.flush()
        if n or d:
            log.debug("R2 上傳 %d、刪除 %d", n, d)
    except Exception:
        log.exception("R2 上傳失敗")


def safe_r2_reconcile():
    try:
        r2.reconcile()
    except Exception:
        log.exception("R2 比對失敗")


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
            job(force=True)
        return

    sched = BlockingScheduler(timezone="UTC")
    for name, job, cron in jobs:
        sched.add_job(job, "cron", id=name, max_instances=1, coalesce=True,
                      misfire_grace_time=50, **cron)
    sched.add_job(safe_ensemble, "cron", minute="7,22,37,52", id="ensemble", max_instances=1, coalesce=True)
    sched.add_job(safe_ecmwf, "cron", minute="4,14,24,34,44,54", id="ecmwf", max_instances=1, coalesce=True)
    sched.add_job(safe_ecmwf, "date", run_date=datetime.now(timezone.utc), id="ecmwf_start")
    sched.add_job(safe_satellite, "cron", minute="*", id="satellite", max_instances=1, coalesce=True,
                  misfire_grace_time=50)
    if r2.enabled():
        sched.add_job(safe_r2_flush, "interval", seconds=30, id="r2_flush", max_instances=1, coalesce=True)
        sched.add_job(safe_r2_reconcile, "date", run_date=datetime.now(timezone.utc), id="r2_reconcile")
        log.info("R2 上傳已啟用:bucket %s", os.environ["R2_BUCKET"])
    else:
        log.info("R2 未設定(.env 沒有 R2_*),只存本機")
    sched.add_job(safe_cleanup, "cron", hour=19, minute=30, id="cleanup")  # 台灣 03:30
    for name, job, _ in jobs:          # 啟動時先跑一輪
        sched.add_job(job, "date", run_date=datetime.now(timezone.utc),
                      kwargs={"force": True}, id=f"{name}_start")
    log.info("排程啟動")
    sched.start()


if __name__ == "__main__":
    main()

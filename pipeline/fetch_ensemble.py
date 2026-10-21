"""系集颱風路徑自動抓取(移植 TY_ENS_3.ipynb):
  ECMWF ENS / AIFS ENS:ECMWF Open Data 的 tf BUFR(pdbufr 解碼)
  NCEP GEFS / AIGEFS :NOMADS ens_tracker 每個成員一個 ATCF-unix 檔
  WeatherLab WNV3 / FNV3P1 / FNV3P2:paired CSV
每個模式輸出 notebook 相同格式的 CSV(storm,name,member,ftype,tau,lat,lon,mslp,outlier)
→ data/typhoon/ens_raw/{init}/{檔名}_tracks.csv,再由 ensemble.import_init 配對、轉成前端格式。

排程:每 15 分執行 run();初始時間 00/06/12/18Z,在「初始時間 +1h ~ +WINDOW_H」內還沒抓到的模式就試一次,
抓到就不再抓;超過窗口仍沒有 → 記一次 missed。
單獨執行:python -m pipeline.fetch_ensemble [--init 2026102100] [--model ECMWF]"""
import argparse
import io
import re
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import requests

from . import ensemble
from .common import log, read_status, record_status

COLUMNS = ["storm", "name", "member", "ftype", "tau", "lat", "lon", "mslp"]
BASIN_LETTER = {"AL": "L", "EP": "E", "CP": "C", "WP": "W", "SH": "S", "IO": "B", "SL": "Q"}
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
WINDOW_H = 12          # 初始時間後幾小時內持續嘗試
OUTLIER_K = 1.5


# ── ECMWF(BUFR)─────────────────────────────────────
def _isnum(x):
    try:
        return x is not None and not (isinstance(x, float) and np.isnan(x))
    except Exception:
        return False


def read_bufr_tracks(path):
    """ECMWF ensemble TC track BUFR → DataFrame(同 notebook):
    每個 subset = 一個成員;只取 meteorologicalAttributeSignificance == 1 的風暴中心;
    第 1 個中心點 = tau 0,之後第 k 個中心點配第 k 個 timePeriod;ensembleForecastType 0 = 控制報。"""
    import pdbufr
    flat = pdbufr.read_bufr(path, flat=True)
    lat_c, lon_c, sig_c, p_c, tp_c = {}, {}, {}, {}, {}
    for col in flat.columns:
        m = re.match(r"#(\d+)#(.+)$", col)
        if not m:
            continue
        n, key = int(m.group(1)), m.group(2)
        {"latitude": lat_c, "longitude": lon_c, "meteorologicalAttributeSignificance": sig_c,
         "pressureReducedToMeanSeaLevel": p_c, "timePeriod": tp_c}.get(key, {})[n] = col
    sig_idx, p_idx, tp_idx = sorted(sig_c), sorted(p_c), sorted(tp_c)

    rows = []
    for _, r in flat.iterrows():
        mem = r.get("#1#ensembleMemberNumber")
        if not _isnum(mem):
            continue
        sid, name, ft = r.get("#1#stormIdentifier"), r.get("#1#longStormName"), r.get("#1#ensembleForecastType")
        tps = [r[tp_c[i]] for i in tp_idx]
        ps = [r[p_c[i]] for i in p_idx]
        centre = 0
        for i in sig_idx:
            if r[sig_c[i]] != 1:
                continue
            la, lo = r.get(lat_c.get(i)), r.get(lon_c.get(i))
            tau = 0 if centre == 0 else (tps[centre - 1] if centre - 1 < len(tps) else None)
            pr = ps[centre] if centre < len(ps) else None
            if _isnum(la) and _isnum(lo) and _isnum(tau):
                lo = float(lo)
                rows.append(dict(storm=sid, name=name, member=int(mem), ftype=int(ft) if _isnum(ft) else -1,
                                 tau=int(tau), lat=float(la), lon=lo - 360 if lo > 180 else lo,
                                 mslp=float(pr) / 100.0 if _isnum(pr) else np.nan))
            centre += 1
    return pd.DataFrame(rows, columns=COLUMNS)


def fetch_ecmwf(model, init):
    """model = 'ifs'(ENS)或 'aifs-ens';還沒上架回 None。ENS 06/18Z 只跑到 144h。"""
    from ecmwf.opendata import Client
    hh = int(init[8:10])
    step = 144 if (model == "ifs" and hh in (6, 18)) else 360
    with tempfile.TemporaryDirectory() as tmp:
        target = str(Path(tmp) / "tracks.bufr")
        try:
            Client(source="ecmwf", model=model).retrieve(
                date=int(init[:8]), time=hh, stream="enfo", type="tf", step=step, target=target)
        except Exception as e:
            log.info("ens %s %s 尚未取得:%s", model, init, str(e)[:120])
            return None
        return read_bufr_tracks(target)


# ── NCEP NOMADS(ATCF)──────────────────────────────
NOMADS = ("https://nomads.ncep.noaa.gov/pub/data/nccf/com/ens_tracker/prod/"
          "{folder}.{date}/{cyc}/tctrack/{member}.t{cyc}z.cyclone.trackatcfunix")
NCEP = {"aigefs": dict(folder="aigefs", member_fmt="a{mem:03d}", n_members=30),
        "gefs": dict(folder="gefs", member_fmt="ap{mem:02d}", n_members=30)}


def parse_ll(tok):
    """'103N'→10.3、'1599E'→159.9、'1269W'→-126.9"""
    tok = tok.strip()
    if not tok:
        return None
    try:
        v = int(tok[:-1]) / 10.0
    except ValueError:
        return None
    return -v if tok[-1] in ("S", "W") else v


def parse_atcf(text, member):
    """ATCF-unix:0 BASIN 1 CY 2 YYYYMMDDHH 4 TECH 5 TAU 6 LAT 7 LON 9 MSLP 27 NAME;同 (風暴, tau) 只取第一列。"""
    rows, seen = [], set()
    for ln in text.splitlines():
        f = [x.strip() for x in ln.split(",")]
        if len(f) < 11:
            continue
        basin, cy, tech = f[0], f[1], f[4]
        try:
            tau_i, cy_i = int(f[5]), int(cy)
        except ValueError:
            continue
        if (basin, cy, tau_i) in seen:
            continue
        seen.add((basin, cy, tau_i))
        la, lo = parse_ll(f[6]), parse_ll(f[7])
        if la is None or lo is None:
            continue
        try:
            p = float(f[9])
            p = p if p > 0 else np.nan
        except ValueError:
            p = np.nan
        storm = f"{cy_i:02d}{BASIN_LETTER.get(basin, basin)}"
        name = f[27] if len(f) > 27 and f[27] else storm
        rows.append(dict(storm=storm, name=name, member=member, ftype=0 if "C00" in tech.upper() else 4,
                         tau=tau_i, lat=la, lon=lo, mslp=p))
    return rows


def fetch_ncep(model, init):
    cfg = NCEP[model]
    date, cyc = init[:8], init[8:10]
    url = lambda mem: NOMADS.format(folder=cfg["folder"], date=date, cyc=cyc, member=cfg["member_fmt"].format(mem=mem))
    # 先問最後一個成員在不在(全部寫完才算上架),不在就不往下抓
    if requests.head(url(cfg["n_members"]), headers=UA, timeout=30).status_code != 200:
        return None
    rows = []
    for mem in range(1, cfg["n_members"] + 1):
        try:
            r = requests.get(url(mem), headers=UA, timeout=120)
            r.raise_for_status()
            rows += parse_atcf(r.text, mem)
        except Exception as e:
            log.warning("ens %s %s 成員 %d 略過:%s", model, init, mem, e)
    return pd.DataFrame(rows, columns=COLUMNS)


# ── Google WeatherLab(paired CSV)─────────────────────
WL_URL = ("https://deepmind.google.com/science/weatherlab/download/cyclones/"
          "{model}/ensemble/paired/csv/{model}_{stamp}_paired.csv")


def fetch_weatherlab(model, init):
    stamp = f"{init[:4]}_{init[4:6]}_{init[6:8]}T{init[8:10]}_00"
    r = requests.get(WL_URL.format(model=model, stamp=stamp), timeout=120,
                     headers={**UA, "Referer": "https://deepmind.google.com/"})
    if r.status_code in (403, 404):
        return None
    r.raise_for_status()
    raw = pd.read_csv(io.StringIO(r.text), comment="#")
    storm = raw["track_id"].map(lambda t: f"{int(t[2:4]):02d}{BASIN_LETTER.get(t[:2], t[:2])}")  # WP092026 → 09W
    return pd.DataFrame({"storm": storm, "name": storm, "member": raw["sample"].astype(int), "ftype": 4,
                         "tau": raw["lead_time_hours"].astype(int), "lat": raw["lat"].astype(float),
                         "lon": raw["lon"].astype(float),
                         "mslp": raw["minimum_sea_level_pressure_hpa"].astype(float)}, columns=COLUMNS)


# ── 離群(同 notebook flag_outliers)────────────────────
def flag_outliers(df, k=OUTLIER_K, min_members=5):
    """每個風暴:各成員到系集共識的平均距離,超過 Q3 + k·IQR 的成員整條標為離群。"""
    df = df.copy()
    df["outlier"] = 0
    for storm, g in df.groupby("storm"):
        if g.member.nunique() < min_members:
            continue
        cons = g.groupby("tau")[["lat", "lon"]].mean()
        dev = {}
        for m, gm in g.groupby("member"):
            gm = gm.set_index("tau")
            common = gm.index.intersection(cons.index)
            if len(common):
                dev[m] = float(np.mean(ensemble.haversine_km(
                    gm.loc[common, "lat"].values, gm.loc[common, "lon"].values,
                    cons.loc[common, "lat"].values, cons.loc[common, "lon"].values)))
        if len(dev) < min_members:
            continue
        q1, q3 = np.percentile(list(dev.values()), [25, 75])
        bad = [m for m, v in dev.items() if v > q3 + k * (q3 - q1)]
        df.loc[(df.storm == storm) & (df.member.isin(bad)), "outlier"] = 1
    return df


# ── 模式表:平台代碼 → (抓取函式, 原始 CSV 檔名;和使用者 notebook 的檔名一致)──
SOURCES = {
    "ECMWF": (lambda i: fetch_ecmwf("ifs", i), "ECMWF_tracks.csv"),
    "AIFS": (lambda i: fetch_ecmwf("aifs-ens", i), "aifs_tracks.csv"),
    "GEFS": (lambda i: fetch_ncep("gefs", i), "gefs_tracks.csv"),
    "AIGEFS": (lambda i: fetch_ncep("aigefs", i), "aigefs_tracks.csv"),
    "WNV3": (lambda i: fetch_weatherlab("WNV3", i), "WNV3_tracks.csv"),
    "FNV3P1": (lambda i: fetch_weatherlab("FNV3P1", i), "FNV3P1_tracks.csv"),
    "FNV3P2": (lambda i: fetch_weatherlab("FNV3P2", i), "FNV3P2_tracks.csv"),
}


def raw_path(model, init):
    return ensemble.RAW_DIR / init / SOURCES[model][1]


def fetch_one(model, init):
    """抓一個模式、一個初始時間 → 存原始 CSV 並重新匯入該初始時間。回傳 'new' / None(尚未上架)/ 'empty'。"""
    df = SOURCES[model][0](init)
    if df is None:
        return None
    if df.empty:
        return "empty"
    df = flag_outliers(df.sort_values(["storm", "member", "tau"]).reset_index(drop=True))
    path = raw_path(model, init)
    path.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(path, index=False)
    log.info("ens %s %s:%d 個風暴、%d 個成員", model, init, df.storm.nunique(), df.member.nunique())
    targets = ensemble.load_targets()
    if targets:
        ensemble.import_init(path.parent, targets)
        ensemble.rebuild_index()
    return "new"


def candidate_inits(now):
    """窗口內(初始時間 +1h ~ +WINDOW_H)的初始時間,新的在前。"""
    out = []
    t = now.replace(minute=0, second=0, microsecond=0)
    t -= timedelta(hours=t.hour % 6)
    while now - t <= timedelta(hours=WINDOW_H + 6):
        if timedelta(hours=1) <= now - t:
            out.append(t)
        t -= timedelta(hours=6)
    return out


_missed = set()
_attempted = set()       # 這次程序啟動後試過的 (模式, 初始時間);沒試過就過窗口的不算 missed(例如排程剛啟動)


def run(models=None):
    """排程每 15 分呼叫;回傳摘要給 scheduler 記錄。"""
    now = datetime.now(timezone.utc)
    got = []
    for t in candidate_inits(now):
        init = t.strftime("%Y%m%d%H")
        for model in models or SOURCES:
            if raw_path(model, init).exists():
                continue
            job = f"ens_{model}"
            if now - t > timedelta(hours=WINDOW_H):
                if (model, init) in _attempted and (model, init) not in _missed:   # 每個初始時間只記一次
                    _missed.add((model, init))
                    record_status(job, "missed", init + "00")
                continue
            _attempted.add((model, init))
            try:
                res = fetch_one(model, init)
            except Exception as e:
                log.warning("ens %s %s 失敗:%s", model, init, e)
                record_status(job, "error", init + "00", error=f"{type(e).__name__}: {e}")
                continue
            if res == "new":
                record_status(job, "new", init + "00", read_status(job).get("data_time"))
                got.append(f"{model}@{init}")
    return got


if __name__ == "__main__":
    import logging
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--init", help="指定初始時間 YYYYMMDDHH(不給 = 依排程窗口)")
    ap.add_argument("--model", action="append", help="只抓這些模式(可重複)")
    a = ap.parse_args()
    if a.init:
        for m in a.model or SOURCES:
            try:
                print(m, fetch_one(m, a.init))
            except Exception as e:
                print(m, "失敗", e)
    else:
        print(run(a.model))

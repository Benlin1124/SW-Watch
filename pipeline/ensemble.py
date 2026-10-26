"""系集颱風路徑匯入:各模式 CSV(TY_ENS_3.ipynb 的輸出格式)→ 前端格式。

輸入:{目錄}/{YYYYMMDDHH}/{model}_tracks.csv
      欄位 storm,name,member,ftype,tau,lat,lon,mslp,outlier(全球所有風暴)
輸出:data/typhoon/ens/{YYYYMMDDHH}.json  只保留配對到「已追蹤颱風」的成員
      data/typhoon/ens/index.json         times = 初始時間;models = 各模式有哪些初始時間
原始 CSV 另存 data/typhoon/ens_raw/{init}/,之後可重新配對。

配對:各模式的風暴代號不一致(ECMWF / AIFS 常和 NCEP、WeatherLab 不同),所以用位置判斷——
成員在 tau ≤ MATCH_MAX_TAU 內,任一時刻距離「該颱風實際位置」≤ MATCH_KM,就歸給該颱風
(同 TY_ENS_3.ipynb 的 filter_pad_full_tracks 概念)。實際位置用氣象署颱風路徑的過去定位內插。

用法:python -m pipeline.ensemble import <目錄或 zip>"""
import argparse
import json
import shutil
import tempfile
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from . import config
from .common import log, save_json, update_index

LAYER = "typhoon/ens"
RAW_DIR = config.DATA_DIR / "typhoon" / "ens_raw"

# 檔名(小寫)→ 平台模式代碼
MODELS = {"ecmwf": "ECMWF", "aifs": "AIFS", "gefs": "GEFS", "aigefs": "AIGEFS",
          "wnv3": "WNV3", "fnv3p1": "FNV3P1", "fnv3p2": "FNV3P2", "fnv3": "FNV3"}
MATCH_KM = 300
MATCH_MAX_TAU = 24


def haversine_km(lat1, lon1, lat2, lon2):
    p = np.pi / 180
    a = (np.sin((lat2 - lat1) * p / 2) ** 2
         + np.cos(lat1 * p) * np.cos(lat2 * p) * np.sin((lon2 - lon1) * p / 2) ** 2)
    return 2 * 6371.0 * np.arcsin(np.sqrt(a))


def _dt(stamp):
    return datetime.strptime(stamp[:12].ljust(12, "0"), "%Y%m%d%H%M").replace(tzinfo=timezone.utc)


def load_targets():
    """所有氣象署颱風路徑檔的過去定位合併 → {颱風 id: {name_zh, name_en, t(秒), lat, lon}}。"""
    fixes = {}
    for p in sorted((config.DATA_DIR / "typhoon" / "cwa_track").glob("[0-9]*.json")):
        for s in json.loads(p.read_text(encoding="utf-8"))["storms"]:
            d = fixes.setdefault(s["id"], {"name_zh": s["name_zh"], "name_en": s["name_en"], "pts": {}})
            for f in s["past"]:
                d["pts"][f["t"]] = (f["lat"], f["lon"] % 360)   # 0–360°,跨換日線內插才連續
    out = {}
    for tid, d in fixes.items():
        ts = sorted(d["pts"])
        out[tid] = dict(name_zh=d["name_zh"], name_en=d["name_en"],
                        t=np.array([_dt(t).timestamp() for t in ts]),
                        lat=np.array([d["pts"][t][0] for t in ts]),
                        lon=np.array([d["pts"][t][1] for t in ts]))
    return out


def target_at(tg, when):
    """颱風在 when(秒)的內插位置;超出已知定位範圍回 NaN。"""
    inside = (when >= tg["t"][0]) & (when <= tg["t"][-1])
    lat = np.where(inside, np.interp(when, tg["t"], tg["lat"]), np.nan)
    lon = np.where(inside, np.interp(when, tg["t"], tg["lon"]), np.nan)
    return lat, lon


def match_members(df, init, targets):
    """回傳 {颱風 id: DataFrame(該颱風的所有成員)}。
    同一成員可能在 CSV 裡以不同風暴代號重複出現(例如生成前後代號不同),
    每個成員只取距離最近的那一條(代號 + 颱風)。"""
    t0 = _dt(init).timestamp()
    early = df[df.tau <= MATCH_MAX_TAU]
    best = {}                                            # member → (距離, 颱風 id, storm)
    for tid, tg in targets.items():
        lat, lon = target_at(tg, t0 + early.tau.to_numpy() * 3600)
        d = haversine_km(early.lat.to_numpy(), early.lon.to_numpy(), lat, lon)
        dist = pd.Series(d, index=early.index).groupby([early.storm, early.member]).min()
        for (storm, member), v in dist.items():
            if np.isfinite(v) and v <= MATCH_KM and v < best.get(member, (np.inf,))[0]:
                best[member] = (v, tid, storm)
    out = {}
    for member, (_, tid, storm) in best.items():
        out.setdefault(tid, []).append(df[(df.storm == storm) & (df.member == member)])
    return {tid: pd.concat(parts) for tid, parts in out.items()}


def members_json(df):
    """壓縮成每成員一組陣列,前端好畫:{m, code, ftype, out, tau[], lat[], lon[], p[]}"""
    res = []
    for (storm, member), g in df.groupby(["storm", "member"], sort=True):
        g = g.sort_values("tau").drop_duplicates("tau")
        res.append(dict(
            m=int(member), code=str(storm).strip(), ftype=int(g.ftype.iloc[0]),
            out=int(g.outlier.max()) if "outlier" in g else 0,
            tau=g.tau.astype(int).tolist(),
            lat=g.lat.round(2).tolist(), lon=g.lon.round(2).tolist(),
            p=[None if pd.isna(v) else round(float(v), 1) for v in g.mslp]))
    return res


def model_of(path):
    stem = path.stem.lower()
    if not stem.endswith("_tracks") or "full_tracks" in stem:
        return None                                  # *_full_tracks.csv 是 notebook 篩過的,改用重新配對
    return MODELS.get(stem[: -len("_tracks")])


def import_init(init_dir, targets):
    init = init_dir.name
    tcs = {}
    for csv in sorted(init_dir.glob("*.csv")):
        model = model_of(csv)
        if not model:
            continue
        df = pd.read_csv(csv)
        df["storm"] = df["storm"].astype(str).str.strip()
        for tid, sub in match_members(df, init, targets).items():
            tg = targets[tid]
            tc = tcs.setdefault(tid, dict(id=tid, name_zh=tg["name_zh"], name_en=tg["name_en"], models={}))
            tc["models"][model] = members_json(sub)
        dst = RAW_DIR / init / csv.name
        dst.parent.mkdir(parents=True, exist_ok=True)
        if csv.resolve() != dst.resolve():
            shutil.copy2(csv, dst)
    if not tcs:
        log.info("ens %s:沒有配對到已追蹤的颱風", init)
        return None
    out = {"init": init, "source": "ECMWF/AIFS/GEFS/AIGEFS/WeatherLab", "tcs": list(tcs.values())}
    save_json(config.DATA_DIR / LAYER / f"{init}.json", out)
    summary = {t["name_en"]: {m: len(v) for m, v in t["models"].items()} for t in out["tcs"]}
    log.info("ens %s:%s", init, summary)
    return out


def rebuild_index():
    """index.json:times = 初始時間(YYYYMMDDHH + '00',和其他圖層一樣 12 碼);models = 各模式初始時間。"""
    models, tcs = {}, {}
    files = sorted((config.DATA_DIR / LAYER).glob("[0-9]*.json"))
    for p in files:
        d = json.loads(p.read_text(encoding="utf-8"))
        for t in d["tcs"]:
            tcs.setdefault(t["id"], {"name_zh": t["name_zh"], "name_en": t["name_en"], "inits": []})["inits"].append(p.stem)
            for m in t["models"]:
                models.setdefault(m, set()).add(p.stem)
    idx_path = config.DATA_DIR / LAYER / "index.json"
    if idx_path.exists():
        idx_path.unlink()
    for p in files:
        update_index(LAYER, p.stem + "00", name="系集颱風路徑",
                     models={m: sorted(v) for m, v in sorted(models.items())}, tcs=tcs,
                     file_pattern="{init}.json(init = YYYYMMDDHH)")


def import_path(src):
    src = Path(src)
    tmp = None
    if src.suffix.lower() == ".zip":
        tmp = Path(tempfile.mkdtemp(prefix="ens_"))
        with zipfile.ZipFile(src) as z:
            z.extractall(tmp)
        src = tmp
    try:
        targets = load_targets()
        if not targets:
            raise RuntimeError("沒有氣象署颱風路徑可以配對(data/typhoon/cwa_track 是空的)")
        dirs = sorted(p for p in src.rglob("*") if p.is_dir() and p.name.isdigit() and len(p.name) == 10)
        for d in dirs:
            import_init(d, targets)
        rebuild_index()
    finally:
        if tmp:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    import logging
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("import", help="匯入目錄或 zip")
    p.add_argument("src")
    sub.add_parser("reindex", help="重新配對 ens_raw 裡的所有原始 CSV 並重建 index")
    a = ap.parse_args()
    if a.cmd == "import":
        import_path(a.src)
    else:
        import_path(RAW_DIR)

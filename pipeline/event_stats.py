"""事件統計圖:一段期間(例如颱風影響期間)各測站的總累積雨量、最大平均風、最大陣風 → PNG + CSV。
色階、風級、底圖與網頁相同(雨量用網頁 ECMWF 長時累積的色階,風用蒲福風級)。
  python -m pipeline.event_stats --start "2026-10-22 00:00" [--end "2026-10-25 12:00"] [--name 薔琵颱風] [--local]
時間為台灣時間;--end 省略 = 最新一筆快照。輸出到 charts/{起}_{迄}/。
本機 data/stations 沒有的快照自動從 R2 下載(存在 pipeline/.cache/stations/),任何一台電腦都能跑;
--local 只用本機資料。

總累積雨量:每站把期間切成首尾相接的幾段,每段用某一筆快照的累積雨量欄位
(10 分鐘、1、3、6、12、24 小時滾動累積;今日、近 2 日、近 3 日的日曆日累積),段數最少的組合相加。
快照缺漏時會改用較長的累積時段跨過去;接不起來的站不畫(log 會列出數量)。
雨量欄位的時間 = 快照時間(與網頁、station_agg 相同)。
注意 CWA 的 Past2days / Past3days(rain_48h / rain_72h)是日曆日(昨天起 / 前天起,台灣 00 時),不是滾動 48 / 72 小時。
最大平均風 / 最大陣風:觀測時間落在期間內的各筆取最大;陣風時間用 gust_at(有的話)。"""
import argparse
import csv
import json
from datetime import datetime, timedelta, timezone

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import requests
import shapely
from shapely.geometry import mapping, shape
from matplotlib.collections import PatchCollection
from matplotlib.colors import BoundaryNorm, ListedColormap
from matplotlib.patches import Polygon as MplPolygon

from . import config, idw
from .common import read_index

TW = timezone(timedelta(hours=8))
R2_URL = "https://pub-95cef959cf924e2e938a1d1b2a833e45.r2.dev/"
BASEMAP = config.ROOT / "web" / "assets" / "basemap"
OUT_DIR = config.ROOT / "charts"
FONT = ["Microsoft JhengHei", "Noto Sans CJK TC", "PingFang TC"]

# 與網頁 web/js/colormaps.js、layers/ecmwf.js 相同
RAIN_LEVELS = [10, 20, 60, 100, 150, 200, 250, 300, 400, 500, 600, 700, 800, 900, 1000, 1200, 1500, 2000]
RAIN_COLORS = ["#c1c2c2", "#9bffff", "#00cfff", "#0198ff", "#0165ff", "#309901", "#32ff00", "#f8ff00",
               "#ffcb00", "#ff9a00", "#fa0300", "#cc0003", "#a00000", "#98009a", "#c304cc", "#f805f3", "#fecbff"]
BEAUFORT = [0, 0.3, 1.6, 3.4, 5.5, 8.0, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7, 37.0, 41.5, 46.2, 51.0, 56.1]
WIND_COLORS = ["#eef5fb", "#c6dbef", "#9ecae1", "#6baed6", "#2171b5", "#74c476", "#238b45",
               "#fff59d", "#ffe03a", "#f5b700", "#ef5350", "#b71c1c", "#ce93d8", "#9c27b0",
               "#6a1b9a", "#4a148c", "#2a0a4a", "#14001f"]
LIGHT = {"bg": "#ffffff", "land": "#f5f5f5", "coast": "#000000", "county": "#1a1a1a"}

# 滾動累積的雨量欄位 → 分鐘數
RAIN_WIN = {"rain_10m": 10, "rain_1h": 60, "rain_3h": 180, "rain_6h": 360, "rain_12h": 720, "rain_24h": 1440}
# 日曆日累積(台灣時間 00 時起算)→ 往前幾天:今日 0、Past2days 昨天起、Past3days 前天起。
# 實測 Past2days 在 00:00 從 640 掉到 558(同時 24 小時 559→558),不是滾動 48 小時。
RAIN_DAYS = {"rain_today": 0, "rain_48h": 1, "rain_72h": 2}
WX = ["ws", "wd", "gust", "gust_dir"]

MAIN = (119.25, 122.15, 21.85, 25.7)           # 本島 + 澎湖、蘭嶼、綠島、彭佳嶼
INSETS = {"金門": (118.18, 118.52, 24.36, 24.55), "馬祖": (119.88, 120.55, 25.92, 26.42)}
REGION = (118.0, 122.3, 21.8, 26.5)            # 納入統計的範圍(排除日本氣象廳站等)


def stamp_dt(s):
    return datetime.strptime(s, "%Y%m%d%H%M").replace(tzinfo=timezone.utc)


def to_stamp(dt):
    return dt.astimezone(timezone.utc).strftime("%Y%m%d%H%M")


def tw(s, fmt="%Y/%m/%d %H:%M"):
    return stamp_dt(s).astimezone(TW).strftime(fmt)


def parse_tw(text):
    return datetime.strptime(text, "%Y-%m-%d %H:%M").replace(tzinfo=TW)


# ── 讀快照 ──
def snapshot_times(use_r2):
    local = set(read_index("stations").get("times", []))
    if use_r2:
        H = {"User-Agent": "Mozilla/5.0"}
        local |= set(requests.get(R2_URL + "stations/index.json", headers=H, timeout=60).json()["times"])
    return sorted(local)


def load_snapshot(stamp, use_r2):
    path = config.DATA_DIR / "stations" / f"{stamp}.json"
    if not path.exists():
        if not use_r2:
            return None
        path = config.CACHE_DIR / "stations" / f"{stamp}.json"
        if not path.exists():
            r = requests.get(f"{R2_URL}stations/{stamp}.json", headers={"User-Agent": "Mozilla/5.0"}, timeout=60)
            if r.status_code != 200:
                return None
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(r.content)
    return json.loads(path.read_text(encoding="utf-8"))


def collect(start, end, use_r2):
    """期間內(雨量多讀 start 之後;風讀觀測時間在 [start, end])的快照 → 站資料與數值陣列。"""
    times = [t for t in snapshot_times(use_r2) if start < t <= end]
    meta, col = {}, {}
    snaps = []
    for i, t in enumerate(times):
        snap = load_snapshot(t, use_r2)
        if snap is None:
            continue
        f = {k: j for j, k in enumerate(snap["fields"])}
        rows = []
        for r in snap["rows"]:
            if "type" in f and r[f["type"]] == "jma":
                continue
            lon, lat = r[f["lon"]], r[f["lat"]]
            if lon is None or not (REGION[0] <= lon <= REGION[1] and REGION[2] <= lat <= REGION[3]):
                continue
            sid = r[f["id"]]
            meta[sid] = {"id": sid, "name": r[f["name"]], "county": r[f.get("county")] if "county" in f else "",
                         "town": r[f["town"]] if "town" in f else "", "lon": lon, "lat": lat}
            col.setdefault(sid, len(col))
            rows.append(r)
        snaps.append((t, f, rows))
        if (i + 1) % 50 == 0:
            print(f"  讀取快照 {i + 1}/{len(times)}")
    return times, snaps, meta, col


# ── 總累積雨量 ──
def total_rain(start, end, snaps, col):
    """每站段數最少的首尾相接組合;回傳 (總雨量, 段數),接不起來為 NaN。"""
    n = len(col)
    done = {start: (np.zeros(n), np.zeros(n))}          # 時間 → (段數, 累積);段數 inf = 到不了
    last = start
    for t, f, rows in snaps:
        ids = np.array([col[r[f["id"]]] for r in rows], dtype=int)
        best_n, best_v = np.full(n, np.inf), np.zeros(n)
        tdt = stamp_dt(t)
        mid = tdt.astimezone(TW).replace(hour=0, minute=0)
        wins = [(k, to_stamp(tdt - timedelta(minutes=m))) for k, m in RAIN_WIN.items() if k in f]
        if mid != tdt.astimezone(TW):          # 00:00 那筆的日累積還是前一天的(今日 = 前一天整天),不用
            wins += [(k, to_stamp(mid - timedelta(days=d))) for k, d in RAIN_DAYS.items() if k in f]
        for k, origin in wins:
            if origin < start or origin not in done:
                continue
            on, ov = done[origin]
            x = np.full(n, np.nan)
            x[ids] = [np.nan if r[f[k]] is None else r[f[k]] for r in rows]
            cn = np.where(np.isfinite(x), on + 1, np.inf)
            better = cn < best_n
            best_n = np.where(better, cn, best_n)
            best_v = np.where(better, ov + np.nan_to_num(x), best_v)
        done[t] = (best_n, best_v)
        last = t
    seg, val = done[last]
    return np.where(np.isfinite(seg), val, np.nan), seg, last


# ── 最大平均風 / 最大陣風 ──
def max_wind(start, end, snaps, col):
    n = len(col)
    out = {v: {"val": np.full(n, np.nan), "dir": np.full(n, np.nan), "at": [None] * n} for v in ("ws", "gust")}
    for t, f, rows in snaps:
        for r in rows:
            obs = r[f["obs"]] or ""
            if not (start <= obs <= end):
                continue
            i = col[r[f["id"]]]
            for v, d in (("ws", "wd"), ("gust", "gust_dir")):
                x = r[f[v]] if v in f else None
                if x is None:
                    continue
                at = r[f["gust_at"]] if v == "gust" and "gust_at" in f and r[f["gust_at"]] else obs
                if v == "gust" and not (start <= at <= end):
                    continue
                o = out[v]
                cur = o["val"][i]
                if np.isnan(cur) or x > cur or (x == cur and at < (o["at"][i] or "")):
                    o["val"][i], o["at"][i] = x, at
                    o["dir"][i] = r[f[d]] if d in f and r[f[d]] is not None else np.nan
    return out


# ── 畫圖 ──
def load_geo(name):
    return json.loads((BASEMAP / f"{name}.json").read_text(encoding="utf-8"))


def taiwan_land():
    """陸地填色用的台灣縣市多邊形(NCDR,同 IDW 陸地遮罩;網頁的 taiwan.json 只有界線),第一次下載後快取。"""
    path = config.CACHE_DIR / "taiwan_county.geojson"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(requests.get(config.TAIWAN_GEOJSON_URL, timeout=120).text, encoding="utf-8")
    gj = json.loads(path.read_text(encoding="utf-8"))
    for f in gj["features"]:
        f["geometry"] = mapping(shapely.make_valid(shape(f["geometry"])).simplify(0.0005))
    return gj


def _rings(geom):
    """各多邊形的外圈(縣市界可能是 GeometryCollection,用 shapely 拆)。"""
    g = shapely.make_valid(shape(geom))
    for part in getattr(g, "geoms", [g]):
        if part.geom_type == "Polygon":
            yield np.asarray(part.exterior.coords)
        elif part.geom_type in ("MultiPolygon", "GeometryCollection"):
            yield from _rings(mapping(part))


def _lines(geom):
    t = geom["type"]
    if t in ("LineString",):
        yield np.asarray(geom["coordinates"])
    elif t == "MultiLineString":
        for c in geom["coordinates"]:
            yield np.asarray(c)
    elif t in ("Polygon", "MultiPolygon"):
        polys = geom["coordinates"] if t == "MultiPolygon" else [geom["coordinates"]]
        for p in polys:
            for ring in p:
                yield np.asarray(ring)


def draw_base(ax, geo, extent):
    """底圖:白色海洋、淺灰陸地(與網頁淺色主題相同);陸地只用台灣縣市界(NCDR)。"""
    x0, x1, y0, y1 = extent
    ax.set_xlim(x0, x1)
    ax.set_ylim(y0, y1)
    ax.set_aspect(1 / np.cos(np.deg2rad((y0 + y1) / 2)))
    ax.set_facecolor(LIGHT["bg"])
    ax.set_xticks([])
    ax.set_yticks([])
    patches = [MplPolygon(r, closed=True) for f in geo["land"]["features"] for r in _rings(f["geometry"])]
    ax.add_collection(PatchCollection(patches, facecolor=LIGHT["land"], edgecolor="none", zorder=0))


def draw_overlay(ax, geo):
    """縣市界(含海岸)疊在資料上面;只用台灣的縣市界,不畫其他國家。"""
    for f in geo["taiwan"]["features"]:
        for c in _lines(f["geometry"]):
            ax.plot(c[:, 0], c[:, 1], color=LIGHT["county"], lw=0.5, zorder=5)


def beaufort(ms):
    return int(np.searchsorted(BEAUFORT, ms, side="right") - 1)


def text_color(hex_):
    r, g, b = (int(hex_[i:i + 2], 16) for i in (1, 3, 5))
    return "#fff" if 0.299 * r + 0.587 * g + 0.114 * b < 140 else "#222"


def legend_blocks(fig, rect, colors, labels, title, cell_text=None, label_at_edges=True):
    """網頁風格的色塊圖例:一格一色,標籤在格線上(雨量)或格子下方(風級)。"""
    ax = fig.add_axes(rect)
    n = len(colors)
    for i, c in enumerate(colors):
        ax.add_patch(plt.Rectangle((i, 0), 1, 1, facecolor=c, edgecolor="#555", lw=0.4))
        if cell_text:
            ax.text(i + 0.5, 0.5, cell_text[i], ha="center", va="center", fontsize=8, fontweight="bold",
                    color=text_color(c))
    for i, lab in enumerate(labels):
        ax.text(i if label_at_edges else i + 0.5, -0.25, lab, ha="center", va="top", fontsize=7.5)
    ax.text(0, 1.25, title, ha="left", va="bottom", fontsize=9.5, fontweight="bold")
    ax.set_xlim(-0.6, n + 0.6)
    ax.set_ylim(-1.2, 2.2)
    ax.axis("off")


def make_figure(geo, title, period, source):
    fig = plt.figure(figsize=(9, 10), dpi=200)
    fig.patch.set_facecolor("white")
    ax = fig.add_axes([0.03, 0.12, 0.62, 0.78])
    fig.text(0.03, 0.965, title, fontsize=17, fontweight="bold", va="top")
    fig.text(0.03, 0.925, period, fontsize=10.5, va="top", color="#333")
    fig.text(0.03, 0.012, source, fontsize=7.5, color="#666", va="bottom")
    draw_base(ax, geo, MAIN)
    insets, top = {}, 0.885
    for name, ext in INSETS.items():                # 金門、馬祖小圖放左上
        w = 0.17
        h = w * (ext[3] - ext[2]) / ((ext[1] - ext[0]) * np.cos(np.deg2rad((ext[2] + ext[3]) / 2))) * 9 / 10
        top -= h + 0.01
        iax = fig.add_axes([0.035, top, w, h])
        draw_base(iax, geo, ext)
        for sp in iax.spines.values():
            sp.set_edgecolor("#888")
        iax.text(0.03, 0.95, name, transform=iax.transAxes, fontsize=8, va="top", zorder=9)
        insets[name] = iax
    return fig, ax, insets


def finish(ax, insets, geo):
    for a in [ax, *insets.values()]:
        draw_overlay(a, geo)


def ranking(fig, rows, title, unit, fmt):
    """右側排行表:站名(縣市)、數值、發生時間。"""
    ax = fig.add_axes([0.67, 0.12, 0.31, 0.78])
    ax.axis("off")
    ax.text(0, 1, title, fontsize=11, fontweight="bold", va="top", transform=ax.transAxes)
    y = 0.955
    for k, r in enumerate(rows):
        ax.text(0.0, y, f"{k + 1:>2}", fontsize=8.5, va="top", color="#666", transform=ax.transAxes)
        ax.text(0.09, y, r["name"], fontsize=9, va="top", fontweight="bold", transform=ax.transAxes)
        ax.text(0.09, y - 0.022, f'{r["county"]}{r["town"]}', fontsize=7, va="top", color="#666",
                transform=ax.transAxes)
        ax.text(1.0, y, f'{fmt(r["v"])} {unit}', fontsize=9.5, va="top", ha="right", fontweight="bold",
                transform=ax.transAxes)
        if r.get("sub"):
            ax.text(1.0, y - 0.022, r["sub"], fontsize=7, va="top", ha="right", color="#666", transform=ax.transAxes)
        y -= 0.05


def label_top(axes, pts, fmt, n, gap=0.12):
    """依數值由大到小標前 n 站;和已標的站距離小於 gap 度就跳過,避免疊字。"""
    placed = []
    for p in pts:
        if len(placed) >= n:
            break
        a = axes(p)
        if a is None or any(abs(p["lon"] - q["lon"]) < gap and abs(p["lat"] - q["lat"]) < gap * 0.6 for q in placed):
            continue
        placed.append(p)
        a.annotate(fmt(p["v"]), (p["lon"], p["lat"]), xytext=(5, 4), textcoords="offset points", fontsize=7,
                   fontweight="bold", zorder=8,
                   bbox=dict(boxstyle="round,pad=0.15", fc="white", ec="#444", lw=0.4, alpha=0.88))


def pick_axes(ax, insets):
    def f(p):
        if MAIN[0] <= p["lon"] <= MAIN[1] and MAIN[2] <= p["lat"] <= MAIN[3]:
            return ax
        for name, ext in INSETS.items():
            if ext[0] <= p["lon"] <= ext[1] and ext[2] <= p["lat"] <= ext[3]:
                return insets[name]
        return None
    return f


def plot_rain(path, geo, stations, total, title, period, source, top):
    fig, ax, insets = make_figure(geo, title, period, source)
    ok = np.isfinite(total)
    lon = np.array([s["lon"] for s in stations])[ok]
    lat = np.array([s["lat"] for s in stations])[ok]
    grid = idw.interpolate(lon, lat, total[ok], idw.land_mask())
    grid = np.where(grid >= RAIN_LEVELS[0], grid, np.nan)
    cmap = ListedColormap(RAIN_COLORS)
    norm = BoundaryNorm(RAIN_LEVELS, cmap.N)
    for a in [ax, *insets.values()]:
        a.contourf(idw.LON, idw.LAT, np.minimum(grid, RAIN_LEVELS[-1] - 0.01), levels=RAIN_LEVELS, cmap=cmap,
                   norm=norm, zorder=2)
        a.scatter(lon, lat, s=1.2, c="#333", lw=0, zorder=6)
    finish(ax, insets, geo)
    pts = sorted(({**s, "v": v} for s, v in zip(stations, total) if np.isfinite(v)), key=lambda p: -p["v"])
    label_top(pick_axes(ax, insets), pts, lambda v: f"{v:.0f}", top)
    ranking(fig, pts[:16], "累積雨量排行", "mm", lambda v: f"{v:.1f}")
    legend_blocks(fig, [0.05, 0.035, 0.58, 0.06], RAIN_COLORS, [str(x) for x in RAIN_LEVELS], "累積雨量 (mm)")
    fig.savefig(path, facecolor="white")
    plt.close(fig)


def plot_wind(path, geo, stations, w, title, period, source, top, label):
    fig, ax, insets = make_figure(geo, title, period, source)
    v = w["val"]
    ok = np.isfinite(v)
    order = np.argsort(np.where(ok, v, -1))            # 風級高的畫在上面
    order = order[ok[order]]
    bf = np.array([beaufort(x) if np.isfinite(x) else 0 for x in v])
    for a in [ax, *insets.values()]:
        for i in order:
            s = stations[i]
            strong = bf[i] >= 14
            r = 1.4 + 0.25 * bf[i]
            a.scatter(s["lon"], s["lat"], s=(2 * r) ** 2, c=WIND_COLORS[bf[i]], zorder=6 + bf[i] * 0.01,
                      edgecolors="#fff" if strong else "#333", linewidths=1.2 if strong else 0.35)
    finish(ax, insets, geo)
    pts = sorted(({**s, "v": x, "at": tw(w["at"][i], "%m/%d %H:%M") if w["at"][i] else ""}
                  for i, (s, x) in enumerate(zip(stations, v)) if np.isfinite(x)), key=lambda p: -p["v"])
    label_top(pick_axes(ax, insets), pts, lambda x: f"{x:.1f}", top)
    ranking(fig, [{**p, "sub": f'{beaufort(p["v"])} 級　{p["at"]}'} for p in pts[:16]], f"{label}排行", "m/s",
            lambda x: f"{x:.1f}")
    legend_blocks(fig, [0.05, 0.035, 0.58, 0.06], WIND_COLORS, [f"{x:g}" for x in BEAUFORT],
                  f"{label}  蒲福風級 / 下界風速 (m/s)", cell_text=[str(k) for k in range(len(WIND_COLORS))],
                  label_at_edges=True)
    fig.savefig(path, facecolor="white")
    plt.close(fig)


def write_csv(path, stations, cols):
    with open(path, "w", newline="", encoding="utf-8-sig") as fp:
        wr = csv.writer(fp)
        wr.writerow(["站號", "站名", "縣市", "鄉鎮", "經度", "緯度", *cols.keys()])
        rows = [[s["id"], s["name"], s["county"], s["town"], s["lon"], s["lat"], *[c[i] for c in cols.values()]]
                for i, s in enumerate(stations)]
        rows.sort(key=lambda r: -(r[6] if isinstance(r[6], (int, float)) and r[6] == r[6] else -1))
        wr.writerows(rows)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--start", required=True, help='台灣時間,例如 "2026-10-22 00:00"')
    ap.add_argument("--end", help="台灣時間;省略 = 最新一筆快照")
    ap.add_argument("--name", default="颱風影響期間", help="標題前綴,例如 薔琵颱風")
    ap.add_argument("--top", type=int, default=10, help="地圖上標數值的站數")
    ap.add_argument("--local", action="store_true", help="只用本機 data/stations,不從 R2 補(排程那台電腦可用)")
    a = ap.parse_args()
    from matplotlib import font_manager
    have = {f.name for f in font_manager.fontManager.ttflist}
    plt.rcParams["font.family"] = [f for f in FONT if f in have] or ["sans-serif"]

    start = to_stamp(parse_tw(a.start))
    times = snapshot_times(not a.local)
    end = to_stamp(parse_tw(a.end)) if a.end else times[-1]
    end = max([t for t in times if t <= end], default=end)
    print(f"期間 {tw(start)} – {tw(end)}(台灣)")
    times, snaps, meta, col = collect(start, end, not a.local)
    print(f"快照 {len(snaps)} 筆(應有 {int((stamp_dt(end) - stamp_dt(start)).total_seconds() // 600)} 筆),測站 {len(col)}")
    stations = [None] * len(col)
    for sid, i in col.items():
        stations[i] = meta[sid]

    total, seg, _ = total_rain(start, end, snaps, col)
    wind = max_wind(start, end, snaps, col)
    print(f"雨量:{int(np.isfinite(total).sum())} 站接得起來;最多 {np.nanmax(total):.1f} mm")

    geo = {"land": taiwan_land(), "taiwan": load_geo("taiwan")}
    out = OUT_DIR / f"{tw(start, '%Y%m%d%H%M')}_{tw(end, '%Y%m%d%H%M')}"
    out.mkdir(parents=True, exist_ok=True)
    period = f"{tw(start)} – {tw(end)}（台灣時間）"
    source = "資料：中央氣象署 自動氣象站、雨量站（10 分鐘觀測）　製圖：SW-Watch"
    plot_rain(out / "rain_total.png", geo, stations, total, f"{a.name} 總累積雨量", period,
              source + "　｜ 測站雨量 IDW 內插，只畫陸地", a.top)
    plot_wind(out / "wind_max.png", geo, stations, wind["ws"], f"{a.name} 最大平均風", period,
              source + "　｜ 10 分鐘平均風速", a.top, "最大平均風")
    plot_wind(out / "gust_max.png", geo, stations, wind["gust"], f"{a.name} 最大陣風", period,
              source, a.top, "最大陣風")
    fmt_at = lambda ts: [tw(t, "%m/%d %H:%M") if t else "" for t in ts]
    write_csv(out / "rain_total.csv", stations, {"總累積雨量(mm)": [round(x, 1) if np.isfinite(x) else "" for x in total],
                                                  "使用段數": [int(x) if np.isfinite(x) else "" for x in seg]})
    write_csv(out / "wind_max.csv", stations, {
        "最大平均風(m/s)": [x if np.isfinite(x) else "" for x in wind["ws"]["val"]],
        "風向(°)": [x if np.isfinite(x) else "" for x in wind["ws"]["dir"]], "發生時間": fmt_at(wind["ws"]["at"]),
        "最大陣風(m/s)": [x if np.isfinite(x) else "" for x in wind["gust"]["val"]],
        "陣風風向(°)": [x if np.isfinite(x) else "" for x in wind["gust"]["dir"]],
        "陣風時間": fmt_at(wind["gust"]["at"])})
    print(f"輸出:{out}")


if __name__ == "__main__":
    main()

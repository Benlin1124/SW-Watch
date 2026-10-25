"""雷達整合回波動畫:一段期間的 data/radar 格點 → MP4(每 10 分鐘一幀)。
回波色階與網頁相同(畫面不放色階)(colormaps.js DBZ_LEVELS / DBZ_COLORS,< 0 dBZ 不畫);底圖:Natural Earth 陸地 + shp/TWN_CITY 縣市界。
  python -m pipeline.radar_video --start "2026-10-22 00:00" [--end "2026-10-25 09:00"] [--fps 8] [--gif]
  加 --typhoon:疊加 CWA 颱風實際路徑(每個定位一點)與 7 級 / 10 級暴風圈(平均半徑正圓,只畫外框),檔名加 _ty
  加 --wind:疊加當下測站平均風(箭頭指向風吹去的方向,蒲福風級上色),檔名加 _wind
  加 --gust:測站風改畫陣風(檔名 _gust)
  加 --no-radar:不畫雷達(只要颱風 / 測站風),時間改用測站快照,檔名 station_…
  python -m pipeline.radar_video --preview ["2026-10-24 12:00"]     # 只輸出一張 PNG 看畫面
時間為台灣時間;--end 省略 = 最新一筆。輸出到 charts/radar/。
本機 data/radar 沒有的檔自動從 R2 下載(存在 pipeline/.cache/radar/);--local 只用本機資料。
MP4 用 imageio-ffmpeg(pip install imageio-ffmpeg,內含 ffmpeg)。"""
import argparse
import gzip
import json
from datetime import timedelta
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import requests
from matplotlib.collections import LineCollection, PatchCollection
from matplotlib.colors import BoundaryNorm, ListedColormap
from matplotlib.patches import Rectangle
from matplotlib.patches import Polygon as MplPolygon
from shapely.geometry import shape

from . import config
from .common import read_index
from .event_stats import BEAUFORT, FONT, LIGHT, R2_URL, WIND_COLORS, WIND_OVER, _polys, load_shp, load_snapshot, save, text_color, snapshot_times, parse_tw, stamp_dt, to_stamp, tw

DBZ_LEVELS = [-5, 0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 85]
DBZ_COLORS = ["#ffffff", "#98ffff", "#009aff", "#1919ff", "#19ff19", "#19cd19",
              "#19A019", "#fefe08", "#ffcb00", "#ff9c00", "#fe0005", "#c90200",
              "#9d0000", "#9a009d", "#cf00d7", "#ff00f7", "#fdcafe"]
EXTENT = (117.4, 125.3, 21.2, 26.6)             # 台灣本島、金馬、澎湖與周圍海面(畫面 4:3,不足處自動補邊)
EXTENT_TW = (120.1, 122.3, 21.3, 25.55)        # --no-radar:放大到台灣本島(左右自動補成 4:3,稍偏東留颱風,底部留色階)
OUT_DIR = config.ROOT / "charts" / "radar"
H = {"User-Agent": "Mozilla/5.0"}
BASEMAP = config.ROOT / "web" / "assets" / "basemap"


def radar_index(use_r2):
    idx = read_index("radar")
    times = set(idx.get("times", []))
    if use_r2:
        r2 = requests.get(R2_URL + "radar/index.json", headers=H, timeout=60).json()
        times |= set(r2["times"])
        idx.setdefault("grid", r2["grid"])
    return sorted(times), idx["grid"]


def load_raw(stamp, g, use_r2):
    path = config.DATA_DIR / "radar" / f"{stamp}.bin.gz"
    if not path.exists():
        if not use_r2:
            return None
        path = config.CACHE_DIR / "radar" / f"{stamp}.bin.gz"
        if not path.exists():
            r = requests.get(f"{R2_URL}radar/{stamp}.bin.gz", headers=H, timeout=60)
            if r.status_code != 200:
                return None
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(r.content)
    return np.frombuffer(gzip.decompress(path.read_bytes()), dtype=np.uint8).reshape(g["ny"], g["nx"])


def lut(g):
    """raw → RGBA,同網頁 binLUT:< 0 dBZ(含 raw 0 無回波)與 nodata 透明,超過最後一級用最後一色。"""
    out = np.zeros((256, 4), dtype=np.uint8)
    for raw in range(g["nodata"]):
        v = raw * g["scale"] + g["offset"]
        if v < 0:
            continue
        i = min(int(np.searchsorted(DBZ_LEVELS, v, side="right") - 1), len(DBZ_COLORS) - 1)
        c = DBZ_COLORS[i]
        out[raw] = [int(c[k:k + 2], 16) for k in (1, 3, 5)] + [255]
    return out


def grid_extent(g):
    """四角近似為矩形(同網頁 radar.js valueAt)。"""
    tl, tr, br, bl = g["corners"]
    return ((tl[0] + bl[0]) / 2, (tr[0] + br[0]) / 2, (bl[1] + br[1]) / 2, (tl[1] + tr[1]) / 2)


def load_world():
    """Natural Earth 陸地(網頁底圖用的那份),補台灣以外的陸地(福建、菲律賓)。"""
    d = json.loads((BASEMAP / "land.json").read_text(encoding="utf-8"))
    return [shape(f["geometry"]) for f in d["features"]]


def make_frame(geo, world, g, title="雷達整合回波", extent=EXTENT):
    """4:3 滿版地圖,標題、時間、來源直接壓在地圖上;回傳 (fig, 回波 image, 時間文字),每幀只換回波和時間。"""
    fig = plt.figure(figsize=(8, 6), dpi=200)                     # 1600 × 1200
    fig.patch.set_facecolor("white")
    ax = fig.add_axes([0, 0, 1, 1])
    x0, x1, y0, y1 = extent
    ax.set_xlim(x0, x1)
    ax.set_ylim(y0, y1)
    ax.set_aspect(1 / np.cos(np.deg2rad((y0 + y1) / 2)), adjustable="datalim")   # 擴範圍填滿畫面,不留白
    ax.set_facecolor(LIGHT["bg"])
    ax.set_xticks([])
    ax.set_yticks([])
    for sp in ax.spines.values():
        sp.set_edgecolor("#888")
        sp.set_linewidth(0.6)
    land = [MplPolygon(np.asarray(p.exterior.coords), closed=True) for w in world for p in _polys(w)]
    land += [MplPolygon(np.asarray(p.exterior.coords), closed=True) for c in geo["city"] for p in _polys(c)]
    ax.add_collection(PatchCollection(land, facecolor=LIGHT["land"], edgecolor="none", zorder=0))
    im = ax.imshow(np.zeros((g["ny"], g["nx"], 4), dtype=np.uint8), origin="lower", extent=grid_extent(g),
                   interpolation="nearest", zorder=2)
    world_lines = [np.asarray(r.coords) for w in world for p in _polys(w) for r in [p.exterior, *p.interiors]]
    ax.add_collection(LineCollection(world_lines, colors="#555", linewidths=0.5, zorder=4))
    city_lines = [np.asarray(r.coords) for c in geo["city"] for p in _polys(c) for r in [p.exterior, *p.interiors]]
    ax.add_collection(LineCollection(city_lines, colors=LIGHT["county"], linewidths=0.5, zorder=5))
    box = dict(boxstyle="square,pad=0.35", facecolor="white", edgecolor="none", alpha=0.85)
    fig.text(0.015, 0.975, title, fontsize=17, fontweight="bold", va="top", bbox=box, zorder=20)
    when = fig.text(0.015, 0.905, "", fontsize=14, va="top", bbox=box, zorder=20)
    fig.text(0.015, 0.84, "資料來源：中央氣象署", fontsize=9, color="#444", va="top", bbox=box, zorder=20)
    return fig, im, when


# ── 颱風路徑、暴風圈(--typhoon)──
C15, C25 = "#f9a825", "#e53935"                  # 7 級 / 10 級暴風圈(同網頁)


def destination(lon, lat, bearing, km):
    """球面上從 (lon, lat) 往方位 bearing 走 km 公里(同網頁 typhoon.js)。"""
    d, b = km / 6371.0088, np.deg2rad(bearing)
    p1, l1 = np.deg2rad(lat), np.deg2rad(lon)
    p2 = np.arcsin(np.sin(p1) * np.cos(d) + np.cos(p1) * np.sin(d) * np.cos(b))
    l2 = l1 + np.arctan2(np.sin(b) * np.sin(d) * np.cos(p1), np.cos(d) - np.sin(p1) * np.sin(p2))
    return np.rad2deg(l2), np.rad2deg(p2)


def wind_circle(lon, lat, r):
    """暴風圈外框;r = 半徑(km)或四象限 [NE, SE, SW, NW](每象限畫 0–90° 圓弧,交界是徑向直線)。"""
    if isinstance(r, list):
        a = np.concatenate([np.arange(q * 90, q * 90 + 91, 3) for q in range(4)])
        rr = np.concatenate([np.full(31, r[q]) for q in range(4)])
    else:
        a, rr = np.arange(0, 361, 3), np.full(121, r)
    x, y = destination(lon, lat, a, rr)
    return np.append(x, x[0]), np.append(y, y[0])


def _ms(stamp):
    return stamp_dt(stamp).timestamp()


class Typhoon:
    """期間內各報 CWA 路徑(typhoon/cwa_track)。
    實際路徑:各報的過去定位合併(同一時間以較晚的報為準,警報期間每小時一個定位);
    只畫實際路徑(到畫面時間為止,氣象署每個定位一個點)、颱風中心、7 級 / 10 級暴風圈(平均半徑正圓,不填色);
    目前位置與半徑:實際定位之間內插,最後一個定位之後沿當下最新一報(初始時間 ≤ 該時間)的預報內插。"""

    def __init__(self, start, end, use_r2):
        idx = read_index("typhoon/cwa_track").get("times", [])
        if use_r2:
            idx = sorted(set(idx) | set(requests.get(R2_URL + "typhoon/cwa_track/index.json", headers=H, timeout=60).json()["times"]))
        lo = to_stamp(stamp_dt(start) - timedelta(days=1))
        self.reports = []                             # [(init, storms)]
        for t in [x for x in idx if lo <= x <= end]:
            d = self._load(t, use_r2)
            if d:
                self.reports.append((t, d["storms"]))
        self.past = {}
        for _, storms in self.reports:
            for st in storms:
                for q in st["past"]:
                    self.past.setdefault(st["id"], {})[q["t"]] = q
        self.artists = []

    @staticmethod
    def _load(stamp, use_r2):
        path = config.DATA_DIR / "typhoon" / "cwa_track" / f"{stamp}.json"
        if not path.exists():
            if not use_r2:
                return None
            path = config.CACHE_DIR / "typhoon" / "cwa_track" / f"{stamp}.json"
            if not path.exists():
                r = requests.get(f"{R2_URL}typhoon/cwa_track/{stamp}.json", headers=H, timeout=60)
                if r.status_code != 200:
                    return None
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(r.content)
        return json.loads(path.read_text(encoding="utf-8"))

    def report_at(self, stamp):
        cur = [r for r in self.reports if r[0] <= stamp]
        return cur[-1][1] if cur else []

    def draw(self, ax, stamp):
        for art in self.artists:
            art.remove()
        self.artists = []
        T = _ms(stamp)
        for st in self.report_at(stamp):
            sid = st["id"]
            past = sorted(self.past.get(sid, {}).values(), key=lambda q: q["t"])
            fcst = []
            if st.get("fcst_init"):
                f0 = _ms(st["fcst_init"])
                fcst = [{**q, "ms": f0 + q["tau"] * 3600} for q in st.get("fcst", [])]
            pts = [{**q, "ms": _ms(q["t"])} for q in past]
            last = pts[-1]["ms"] if pts else -1
            pts += [q for q in fcst if q["ms"] > last]
            if not pts or T < pts[0]["ms"] or T > pts[-1]["ms"]:
                continue
            now = self._interp(pts, T)
            seen = [q for q in pts if q["ms"] <= T and q.get("t")]
            px = [q["lon"] for q in seen] + [now["lon"]]
            py = [q["lat"] for q in seen] + [now["lat"]]
            self.artists += ax.plot(px, py, color="#222", lw=1.6, zorder=8, solid_capstyle="round")
            # 定位點只畫氣象署實際給的(警報期間每小時,之前 3 / 6 小時),不內插
            self.artists += ax.plot(px[:-1], py[:-1], "o", ms=3, mfc="#222", mec="none", zorder=9)
            for key, color in (("r15", C15), ("r25", C25)):                        # 平均半徑正圓,只畫外框
                if now.get(key):
                    x, y = wind_circle(now["lon"], now["lat"], now[key])
                    self.artists += ax.plot(x, y, color=color, lw=2.2, zorder=10)
            self.artists += ax.plot(now["lon"], now["lat"], "o", ms=11, mfc="#e53935", mec="white", mew=2, zorder=11)

    @staticmethod
    def _interp(pts, T):
        """T 前後兩點內插位置與暴風圈(四象限兩端都有才內插,否則取較近的一端)。"""
        for a, b in zip(pts, pts[1:]):
            if a["ms"] <= T <= b["ms"]:
                f = (T - a["ms"]) / (b["ms"] - a["ms"] or 1)
                near = a if f < 0.5 else b
                out = {k: a[k] + (b[k] - a[k]) * f for k in ("lon", "lat")}
                for k in ("r15", "r25"):
                    out[k] = a[k] + (b[k] - a[k]) * f if a.get(k) and b.get(k) else near.get(k)
                    qa, qb = a.get(k + "q"), b.get(k + "q")
                    out[k + "q"] = [x + (y - x) * f for x, y in zip(qa, qb)] if qa and qb else near.get(k + "q")
                return out
        return dict(pts[-1])


# ── 測站風(--wind)──
class StationWind:
    """當下(與雷達同一個 10 分鐘)測站快照的平均風(gust=True 改陣風 gust / gust_dir):箭頭指向風吹去的方向(同網頁 wd + 180),
    顏色依蒲福風級(同網頁 / 統計圖,>17 用 WIND_OVER),大小隨風級放大,級數高的畫在上面;
    風速 0 或沒有風向畫小圓點。觀測時間比畫面時間早 60 分鐘以上的不畫。"""
    MAX_AGE = 60

    def __init__(self, use_r2, gust=False):
        self.use_r2 = use_r2
        self.var, self.dir = ("gust", "gust_dir") if gust else ("ws", "wd")
        self.artists = []
        self.cmap = ListedColormap(WIND_COLORS + [WIND_OVER])
        self.norm = BoundaryNorm(BEAUFORT + [999], self.cmap.N)

    def draw(self, ax, stamp):
        for art in self.artists:
            art.remove()
        self.artists = []
        snap = load_snapshot(stamp, self.use_r2)
        if not snap:
            return
        f = {k: i for i, k in enumerate(snap["fields"])}
        lo = to_stamp(stamp_dt(stamp) - timedelta(minutes=self.MAX_AGE))
        arrows, dots = [], []
        for r in snap["rows"]:
            ws = r[f[self.var]]
            if (f.get("type") is not None and r[f["type"]] == "jma") or ws is None or not (lo < (r[f["obs"]] or "") <= stamp):
                continue
            wd = r[f[self.dir]]
            (arrows if ws > 0 and wd is not None else dots).append((r[f["lon"]], r[f["lat"]], ws, wd))
        if dots:
            x, y, w, _ = zip(*dots)
            self.artists.append(ax.scatter(x, y, s=6, c=w, cmap=self.cmap, norm=self.norm,
                                           edgecolors="#333", linewidths=0.3, zorder=6))
        if arrows:
            arrows.sort(key=lambda a: a[2])
            x, y, w, wd = (np.array(v, dtype=float) for v in zip(*arrows))
            bf = np.searchsorted(BEAUFORT, w, side="right") - 1
            L = 0.07 + 0.012 * bf                                   # 箭頭長度(英寸),隨風級放大
            to = np.deg2rad(wd + 180)
            self.artists.append(ax.quiver(x, y, L * np.sin(to), L * np.cos(to), w, cmap=self.cmap, norm=self.norm,
                                          angles="uv", scale_units="inches", scale=1, pivot="middle",
                                          width=0.0028, headwidth=3.2, headlength=3.2, headaxislength=2.8,
                                          edgecolor="#222", linewidth=0.35, zorder=7))


def wind_colorbar(fig):
    """底部橫式蒲福風級色階(同統計圖 wind_max.png:格子裡標級數,最後一格 >17),
    數字標在格子交界上方(該級下界),底下襯半透明白底。"""
    colors = WIND_COLORS + [WIND_OVER]
    w, y0, h = 0.735, 0.018, 0.032
    x0 = (1 - w) / 2                                            # 置中
    fig.patches.append(Rectangle((x0 - 0.045, 0.006), w + 0.053, 0.085, transform=fig.transFigure,
                                 facecolor="white", edgecolor="none", alpha=0.85, zorder=15))
    cax = fig.add_axes([x0, y0, w, h], zorder=20)
    cax.set_xlim(0, len(colors))
    cax.set_ylim(0, 1)
    cax.axis("off")
    for i, c in enumerate(colors):
        cax.add_patch(Rectangle((i, 0), 1, 1, facecolor=c, edgecolor="#555", linewidth=0.3))
        cax.text(i + 0.5, 0.5, ">17" if i == len(WIND_COLORS) else str(i), ha="center", va="center",
                 fontsize=7.5, fontweight="bold", color=text_color(c))
    for i, v in enumerate(BEAUFORT):
        cax.text(i, 1.15, f"{v:g}", ha="center", va="bottom", fontsize=7.5)
    fig.text(x0 - 0.008, y0 + h / 2, "m/s", ha="right", va="center", fontsize=9, zorder=20)


def set_frame(im, when, raw, table, stamp, overlays=()):
    im.set_data(table[raw])
    for o in overlays:
        o.draw(im.axes, stamp)
    when.set_text(tw(stamp, "%Y/%m/%d %H:%M") + " (台灣時間)")


def main():
    plt.rcParams["font.sans-serif"] = FONT + plt.rcParams["font.sans-serif"]
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--start", help="開始(台灣時間 YYYY-MM-DD HH:MM)")
    p.add_argument("--end", help="結束(台灣時間);省略 = 最新一筆")
    p.add_argument("--preview", nargs="?", const="latest", help="只輸出一張 PNG(可給台灣時間;省略 = 最新一筆)")
    p.add_argument("--fps", type=float, default=8)
    p.add_argument("--gif", action="store_true", help="另外輸出 GIF")
    p.add_argument("--shp", default=str(config.ROOT / "shp"), help="TWN_CITY 所在資料夾")
    p.add_argument("--typhoon", action="store_true", help="疊加颱風路徑與 7 級 / 10 級暴風圈(只畫外框)")
    p.add_argument("--wind", action="store_true", help="疊加測站平均風(蒲福風級顏色箭頭)")
    p.add_argument("--gust", action="store_true", help="--wind 改畫陣風(gust / gust_dir)")
    p.add_argument("--no-radar", action="store_true", help="不畫雷達(搭配 --wind / --typhoon;時間改用測站快照)")
    p.add_argument("--local", action="store_true", help="只用本機 data/radar")
    a = p.parse_args()
    use_r2 = not a.local

    times, g = radar_index(use_r2)
    table = lut(g)
    load = lambda t: load_raw(t, g, use_r2)
    title, prefix = "雷達整合回波", "radar"
    if a.no_radar:                                       # 回波全畫成 raw 0(透明),時間用測站快照
        times = snapshot_times(use_r2)
        blank = np.zeros((g["ny"], g["nx"]), dtype=np.uint8)
        load = lambda t: blank
        wname = "測站陣風" if a.gust else "測站平均風"
        title, prefix = (f"颱風位置與{wname}" if a.typhoon else wname) if a.wind else "颱風路徑", "station"
    geo, world = load_shp(Path(a.shp)), load_world()
    fig, im, when = make_frame(geo, world, g, title, EXTENT_TW if a.no_radar else EXTENT)
    if a.wind:
        wind_colorbar(fig)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    suffix = ("_ty" if a.typhoon else "") + (("_gust" if a.gust else "_wind") if a.wind else "")
    wind = [StationWind(use_r2, a.gust)] if a.wind else []

    if a.preview:
        stamp = times[-1] if a.preview == "latest" else max(t for t in times if t <= to_stamp(parse_tw(a.preview)))
        ty = [Typhoon(stamp, stamp, use_r2)] if a.typhoon else []
        set_frame(im, when, load(stamp), table, stamp, wind + ty)
        out = OUT_DIR / f"{prefix}_{tw(stamp, '%Y%m%d%H%M')}{suffix}.png"
        save(fig, out)                                   # 檔案被看圖軟體開著時改存 _new
        print(f"預覽 {tw(stamp)} → {out}")
        return

    if not a.start:
        p.error("要給 --start(或用 --preview)")
    start = to_stamp(parse_tw(a.start))
    end = to_stamp(parse_tw(a.end)) if a.end else times[-1]
    sel = [t for t in times if start <= t <= end]
    if not sel:
        p.error("期間內沒有雷達資料")
    import imageio_ffmpeg
    ty = [Typhoon(sel[0], sel[-1], use_r2)] if a.typhoon else []
    name = f"{prefix}_{tw(sel[0], '%Y%m%d%H%M')}_{tw(sel[-1], '%Y%m%d%H%M')}{suffix}"
    fig.canvas.draw()
    w, h = fig.canvas.get_width_height()
    writer = imageio_ffmpeg.write_frames(str(OUT_DIR / f"{name}.mp4"), (w, h), fps=a.fps, quality=8,
                                         pix_fmt_out="yuv420p", macro_block_size=8)
    writer.send(None)
    gif = []
    missing = 0
    for i, t in enumerate(sel):
        raw = load(t)
        if raw is None:
            missing += 1
            continue
        set_frame(im, when, raw, table, t, wind + ty)
        fig.canvas.draw()
        frame = np.asarray(fig.canvas.buffer_rgba())[:, :, :3]
        writer.send(np.ascontiguousarray(frame))
        if a.gif:
            gif.append(frame[::2, ::2].copy())
        if (i + 1) % 50 == 0:
            print(f"  {i + 1}/{len(sel)}")
    writer.close()
    print(f"{tw(sel[0])} ~ {tw(sel[-1])}:{len(sel) - missing} 幀(缺 {missing})→ {OUT_DIR / (name + '.mp4')}")
    if a.gif:
        import imageio.v2 as imageio
        imageio.mimsave(OUT_DIR / f"{name}.gif", gif, duration=1 / a.fps, loop=0)
        print(f"  GIF → {OUT_DIR / (name + '.gif')}")


if __name__ == "__main__":
    main()

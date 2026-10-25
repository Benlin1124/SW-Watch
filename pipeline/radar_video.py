"""雷達整合回波動畫:一段期間的 data/radar 格點 → MP4(每 10 分鐘一幀)。
回波色階與網頁相同(畫面不放色階)(colormaps.js DBZ_LEVELS / DBZ_COLORS,< 0 dBZ 不畫);底圖:Natural Earth 陸地 + shp/TWN_CITY 縣市界。
  python -m pipeline.radar_video --start "2026-10-22 00:00" [--end "2026-10-25 09:00"] [--fps 8] [--gif]
  python -m pipeline.radar_video --preview ["2026-10-24 12:00"]     # 只輸出一張 PNG 看畫面
時間為台灣時間;--end 省略 = 最新一筆。輸出到 charts/radar/。
本機 data/radar 沒有的檔自動從 R2 下載(存在 pipeline/.cache/radar/);--local 只用本機資料。
MP4 用 imageio-ffmpeg(pip install imageio-ffmpeg,內含 ffmpeg)。"""
import argparse
import gzip
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import requests
from matplotlib.collections import LineCollection, PatchCollection
from matplotlib.patches import Polygon as MplPolygon
from shapely.geometry import shape

from . import config
from .common import read_index
from .event_stats import FONT, LIGHT, R2_URL, _polys, load_shp, parse_tw, to_stamp, tw

DBZ_LEVELS = [-5, 0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 85]
DBZ_COLORS = ["#ffffff", "#98ffff", "#009aff", "#1919ff", "#19ff19", "#19cd19",
              "#19A019", "#fefe08", "#ffcb00", "#ff9c00", "#fe0005", "#c90200",
              "#9d0000", "#9a009d", "#cf00d7", "#ff00f7", "#fdcafe"]
EXTENT = (117.4, 125.3, 21.2, 26.6)             # 台灣本島、金馬、澎湖與周圍海面(畫面 4:3,不足處自動補邊)
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


def make_frame(geo, world, g):
    """4:3 滿版地圖,標題、時間、來源直接壓在地圖上;回傳 (fig, 回波 image, 時間文字),每幀只換回波和時間。"""
    fig = plt.figure(figsize=(8, 6), dpi=200)                     # 1600 × 1200
    fig.patch.set_facecolor("white")
    ax = fig.add_axes([0, 0, 1, 1])
    x0, x1, y0, y1 = EXTENT
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
    fig.text(0.015, 0.975, "雷達整合回波", fontsize=17, fontweight="bold", va="top", bbox=box, zorder=20)
    when = fig.text(0.015, 0.905, "", fontsize=14, va="top", bbox=box, zorder=20)
    fig.text(0.015, 0.02, "資料來源：中央氣象署", fontsize=9, color="#444", va="bottom", bbox=box, zorder=20)
    return fig, im, when


def set_frame(im, when, raw, table, stamp):
    im.set_data(table[raw])
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
    p.add_argument("--local", action="store_true", help="只用本機 data/radar")
    a = p.parse_args()
    use_r2 = not a.local

    times, g = radar_index(use_r2)
    table = lut(g)
    geo, world = load_shp(Path(a.shp)), load_world()
    fig, im, when = make_frame(geo, world, g)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    if a.preview:
        stamp = times[-1] if a.preview == "latest" else max(t for t in times if t <= to_stamp(parse_tw(a.preview)))
        set_frame(im, when, load_raw(stamp, g, use_r2), table, stamp)
        out = OUT_DIR / f"radar_{tw(stamp, '%Y%m%d%H%M')}.png"
        fig.savefig(out, facecolor="white")
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
    name = f"radar_{tw(sel[0], '%Y%m%d%H%M')}_{tw(sel[-1], '%Y%m%d%H%M')}"
    fig.canvas.draw()
    w, h = fig.canvas.get_width_height()
    writer = imageio_ffmpeg.write_frames(str(OUT_DIR / f"{name}.mp4"), (w, h), fps=a.fps, quality=8,
                                         pix_fmt_out="yuv420p", macro_block_size=8)
    writer.send(None)
    gif = []
    missing = 0
    for i, t in enumerate(sel):
        raw = load_raw(t, g, use_r2)
        if raw is None:
            missing += 1
            continue
        set_frame(im, when, raw, table, t)
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

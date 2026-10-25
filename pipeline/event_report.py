"""颱風 / 豪雨事件一鍵產出:統計圖表(event_stats)+ 縮時影片(radar_video)+ 摘要與 YouTube 標題說明。
  python -m pipeline.event_report --start "2026-10-22 00:00" [--end "2026-10-24 20:00"] [--name 薔琵颱風]
時間為台灣時間;--end 省略 = 最新一筆測站快照。輸出全部放在 charts/{起}_{迄}_{名稱}/:
  rain_total.png、rain_total_station.png、wind_max.png、gust_max.png、*.csv、county_stats.xlsx(同 event_stats)
  影片 *.mp4(同 radar_video)、summary.txt(事件總結)、youtube.txt(每支影片的標題 + 說明,可直接貼)
事件種類(--kind,預設 auto):期間內有颱風中心(氣象署定位)進入台灣本島 500 km 內 → typhoon,否則 rain。
  typhoon:影片 radar、radar_ty、gust、wind 四支,摘要含颱風生命史與最接近台灣的時間;名稱預設「{颱風名}颱風」。
  rain:影片只有 radar,摘要著重最大時雨量、24 小時雨量與豪雨標準站數;名稱預設「豪雨事件」。
--videos radar,radar_ty,gust,wind 指定要哪幾支;--no-video 只做統計和摘要(快很多)。
影片要在前景執行(背景執行 ffmpeg 會 WinError 6)。本機沒有的資料自動從 R2 下載;--local 只用本機。"""
import argparse
from datetime import timedelta
from pathlib import Path

import numpy as np
import shapely

from . import config, event_stats, radar_video
from .event_stats import bf_label, parse_tw, stamp_dt, to_stamp, tw

NEAR_KM = 500                     # 颱風中心離本島海岸這麼近才算颱風事件
VIDEOS = {"radar": {}, "radar_ty": {"typhoon": True},
          "gust": {"typhoon": True, "wind": True, "gust": True, "no_radar": True},
          "wind": {"typhoon": True, "wind": True, "no_radar": True}}
# 氣象署雨量分級(24 小時累積;大雨另有時雨量 40 mm、豪雨另有 3 小時 100 mm)
RAIN_CLASS = [("大雨", 80), ("豪雨", 200), ("大豪雨", 350), ("超大豪雨", 500)]
SITE = "https://benlin1124.github.io/SW-Watch/"


# ── 颱風 ──
def stage(ms):
    return "熱帶性低氣壓" if ms < 17.2 else "輕度颱風" if ms < 32.7 else "中度颱風" if ms < 51.0 else "強烈颱風"


def main_island(geo):
    """台灣本島 = TWN_CITY 合併後面積最大的多邊形。"""
    u = shapely.union_all(geo["city"])
    return max(event_stats._polys(u), key=lambda p: p.area)


def coast_km(island, lon, lat):
    """颱風中心到本島海岸的距離(km,大圓);中心在陸地上回傳 0。"""
    if island.contains(shapely.Point(lon, lat)):
        return 0.0
    c = np.deg2rad(np.asarray(island.exterior.coords))
    p1, l1 = np.deg2rad(lat), np.deg2rad(lon)
    a = np.sin((c[:, 1] - p1) / 2) ** 2 + np.cos(p1) * np.cos(c[:, 1]) * np.sin((c[:, 0] - l1) / 2) ** 2
    return float(6371.0088 * 2 * np.arcsin(np.sqrt(a)).min())


def storms_near(start, end, use_r2, geo):
    """期間內(往前多看一天)中心進入本島 NEAR_KM 內的颱風 → [dict(name, fixes, closest…)],依最近距離排序。"""
    ty = radar_video.Typhoon(start, end, use_r2)
    info = {}
    for _, storms in ty.reports:
        for st in storms:
            info[st["id"]] = st
    island = main_island(geo)
    lo = to_stamp(stamp_dt(start) - timedelta(days=1))
    out = []
    for sid, past in ty.past.items():
        fixes = sorted(past.values(), key=lambda q: q["t"])
        near = [(coast_km(island, q["lon"], q["lat"]), q) for q in fixes if lo <= q["t"] <= end]
        if not near:
            continue
        d, q = min(near, key=lambda x: (x[0], x[1]["t"]))
        if d > NEAR_KM:
            continue
        st = info[sid]
        out.append({"id": sid, "name_zh": st.get("name_zh") or "", "name_en": st.get("name_en") or "",
                    "ty_no": st.get("ty_no"), "year": st.get("year"), "fixes": fixes, "closest": (d, q)})
    return sorted(out, key=lambda s: s["closest"][0])


def storm_lines(s):
    """颱風生命史(強度等級變化、巔峰、最接近本島、最後定位)。"""
    fx = [q for q in s["fixes"] if q.get("wind") is not None]
    lines = []
    prev = None
    for q in fx:
        k = stage(q["wind"])
        if k != prev:
            if prev is None:
                lines.append(f"・{tw(q['t'], '%m/%d %H:%M')} 首次定位,{k}(約 {q['lon']:.1f}°E、{q['lat']:.1f}°N)")
            else:
                up = ["熱帶性低氣壓", "輕度颱風", "中度颱風", "強烈颱風"]
                verb = "增強" if up.index(k) > up.index(prev) else "減弱"
                lines.append(f"・{tw(q['t'], '%m/%d %H:%M')} {verb}為{k}")
            prev = k
    pk = max(fx, key=lambda q: (q["wind"], -(q.get("pres") or 9999)))
    lines.append(f"・巔峰 {tw(pk['t'], '%m/%d %H:%M')}:近中心最大風速 {pk['wind']:g} m/s({bf_text(pk['wind'])})"
                 + (f"、陣風 {pk['gust']:g} m/s" if pk.get("gust") else "")
                 + (f"、中心氣壓 {pk['pres']:g} hPa" if pk.get("pres") else ""))
    d, q = s["closest"]
    where = "中心定位在本島陸地上(是否登陸以氣象署認定為準)" if d == 0 else f"中心距本島海岸約 {d:.0f} km"
    lines.append(f"・最接近台灣 {tw(q['t'], '%m/%d %H:%M')}:{where}({q['lon']:.1f}°E、{q['lat']:.1f}°N),"
                 f"{stage(q['wind'])},近中心最大風速 {q['wind']:g} m/s"
                 + (f",七級風半徑 {q['r15']:g} km" if q.get("r15") else "")
                 + (f"、十級風半徑 {q['r25']:g} km" if q.get("r25") else ""))
    last = fx[-1]
    lines.append(f"・最後定位 {tw(last['t'], '%m/%d %H:%M')}:{stage(last['wind'])},{last['wind']:g} m/s"
                 + (f"、{last['pres']:g} hPa" if last.get("pres") else ""))
    return lines


# ── 測站排行 ──
def bf_text(ms):
    k = bf_label(ms)
    return "17 級以上" if k == ">17" else f"{k} 級"


def place(s):
    return f"{s['county']}{s['town']}"


def ranking(stations, vals, at, n, fmt):
    """依數值由大到小前 n 站 → 文字列;fmt(值) 回傳數值文字。"""
    ok = [i for i in range(len(stations)) if np.isfinite(vals[i])]
    ok.sort(key=lambda i: (-vals[i], at[i] or "") if at else -vals[i])
    names = [stations[i]["name"] for i in ok[:n]]
    out = []
    for k, i in enumerate(ok[:n], 1):
        s = stations[i]
        alt = f",海拔 {event_stats.fmt_alt(s['alt'])} m" if names.count(s["name"]) > 1 and s["alt"] is not None else ""
        t = f"  {tw(at[i], '%m/%d %H:%M')}" if at and at[i] else ""
        out.append(f"{k}. {s['name']}({place(s)}{alt}){fmt(vals[i])}{t}")
    return out


def fullwidth(text):
    """貼到 YouTube 用全形括號、冒號(時間 12:30 與網址不動)。"""
    out = []
    for line in text.split("\n"):
        if "http" not in line:
            for a, b in (("(", "（"), (")", "）"), (",", "，"), ("+", "＋"), ("|", "｜")):
                line = line.replace(a, b)
            line = "".join("：" if c == ":" and not (0 < i < len(line) - 1 and line[i - 1].isdigit()
                                                          and line[i + 1].isdigit()) else c for i, c in enumerate(line))
        out.append(line)
    return "\n".join(out)


def summary_text(r, name, kind, storms, top):
    st, start, end = r["stations"], r["start"], r["end"]
    w, rm, total = r["wind"], r["rmax"], r["total"]
    L = ["━━━━━━━━━━━━━━━━━━", f"🌀 {name} 總結" if kind == "typhoon" else f"🌧 {name} 總結",
         "━━━━━━━━━━━━━━━━━━", f"統計期間:{tw(start)} – {tw(end)}(台灣時間)", ""]
    for s in storms:
        tag = f"{s['name_zh']}颱風({s['name_en']}" + (f",{s['year']} 年第 {s['ty_no']} 號" if s.get("ty_no") else "") + ")"
        L += [f"▍{tag}", *storm_lines(s), ""]

    gust = ranking(st, w["gust"]["val"], w["gust"]["at"], top, lambda v: f" {v:.1f} m/s　{bf_text(v)}")
    mean = ranking(st, w["ws"]["val"], w["ws"]["at"], top, lambda v: f" {v:.1f} m/s　{bf_text(v)}")
    wind_block = ["▍最大陣風", *gust, "", "▍最大平均風", *mean, ""]
    tot = ranking(st, total, None, top, lambda v: f" {v:.1f} mm")
    cnt = "、".join(f"{t} mm 以上 {int(np.nansum(total >= t))} 站" for t in (500, 350, 200) if np.nansum(total >= t))
    rain_block = ["▍總累積雨量", *tot] + ([f"累積雨量 {cnt}。"] if cnt else []) + [""]
    h1 = ranking(st, rm["rain_1h"]["val"], rm["rain_1h"]["at"], top, lambda v: f" {v:.1f} mm")
    h24 = ranking(st, rm["rain_24h"]["val"], rm["rain_24h"]["at"], top, lambda v: f" {v:.1f} mm")
    v24, v3, v1 = (rm[k]["val"] for k in ("rain_24h", "rain_3h", "rain_1h"))
    cls = [f"{lab}(24 小時 ≥ {t} mm){int(np.nansum(v24 >= t))} 站" for lab, t in RAIN_CLASS]
    cls += [f"時雨量 ≥ 40 mm {int(np.nansum(v1 >= 40))} 站", f"3 小時 ≥ 100 mm {int(np.nansum(v3 >= 100))} 站"]
    short_block = ["▍最大時雨量", *h1, "", "▍最大 24 小時雨量", *h24, "",
                   "▍達氣象署雨量分級的測站數", *[f"・{c}" for c in cls], ""]
    L += (wind_block + rain_block + short_block) if kind == "typhoon" else (rain_block + short_block + wind_block)
    L.append("※ 統計為中央氣象署自動氣象站即時資料整理,未經品管,數值以氣象署正式報告為準。")
    return fullwidth("\n".join(L))


# ── YouTube ──
def period(a, b):
    if tw(a, "%Y%m%d") == tw(b, "%Y%m%d"):
        return tw(a, "%Y/%m/%d")
    return f"{tw(a, '%Y/%m/%d')}–{tw(b, '%m/%d') if tw(a, '%Y') == tw(b, '%Y') else tw(b, '%Y/%m/%d')}"


def gap_text(gaps):
    return "、".join(f"{tw(a, '%m/%d %H:%M')}–{tw(b, '%H:%M' if tw(a, '%d') == tw(b, '%d') else '%m/%d %H:%M')}"
                     for a, b in gaps)


LEGEND_TY = ["● 紅點:當下颱風中心",
             "— 黑線與小點:氣象署實際定位(只畫氣象署公布的定位點,不另外內插)",
             "◯ 黃圈:七級風暴風半徑(平均半徑)", "◯ 紅圈:十級風暴風半徑(平均半徑)"]
LEGEND_WIND = ["➤ 箭頭:指向風吹去的方向,顏色與長度依蒲福風級(底部色階 0–17 級)", "・ 小圓點:靜風或無風向資料"]


def youtube_text(name, kind, results, summary, fps):
    blocks = []
    for key, v in results.items():
        a, b = v["first"], v["last"]
        p = period(a, b)
        if key == "radar":
            title = f"{name} 雷達回波縮時|{p} 台灣周邊雷達整合回波"
            what, src, legend = "雷達整合回波縮時影片", "雷達整合回波", []
        elif key == "radar_ty":
            title = f"{name} 路徑+暴風圈+雷達回波|{p} 縮時"
            what, src, legend = "雷達整合回波疊加颱風實際路徑與暴風圈的縮時影片", "雷達整合回波、颱風路徑", LEGEND_TY
        else:
            wn = "陣風" if key == "gust" else "平均風(10 分鐘平均)"
            title = f"{name} 全台測站{wn.split('(')[0]}變化|颱風路徑+暴風圈 {p}"
            what, src = f"全台氣象站{wn}與颱風路徑、暴風圈的縮時影片", "自動氣象站、颱風路徑"
            legend = [LEGEND_WIND[0].replace("箭頭:", f"箭頭:測站{wn},"), LEGEND_WIND[1], *LEGEND_TY]
        d = [f"{name}期間的{what}。", "",
             f"📅 時間:{tw(a, '%Y/%m/%d %H:%M')} – {tw(b, '%m/%d %H:%M')}(台灣時間)",
             f"⏱ 每格 10 分鐘,{fps:g} fps,約 {v['seconds']:.0f} 秒"]
        if legend:
            d += ["", "圖例說明:", *legend]
        if key.startswith("radar") and v["gaps"]:
            d += ["", f"※ 部分時段雷達資料缺漏({gap_text(v['gaps'])}),影片中會略過。"]
        d += ["", summary, "", f"資料來源:中央氣象署({src})", f"製作：SW-Watch 劇烈天氣監控平台 {SITE}"]
        tags = f"#{name} #氣象 #台灣" + (" #颱風" if kind == "typhoon" else " #豪雨")
        blocks.append(f"################ {v['path'].name}\n"
                      + fullwidth("\n".join(["【標題】", title, "", "【說明】", *d, "", tags])))
    return "\n\n\n".join(blocks)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--start", required=True, help='台灣時間,例如 "2026-10-22 00:00"')
    ap.add_argument("--end", help="台灣時間;省略 = 最新一筆快照")
    ap.add_argument("--name", help="事件名稱(標題、資料夾用);省略 = 颱風名或「豪雨事件」")
    ap.add_argument("--kind", choices=["auto", "typhoon", "rain"], default="auto")
    ap.add_argument("--videos", help="逗號分隔:radar,radar_ty,gust,wind;省略依事件種類")
    ap.add_argument("--no-video", action="store_true", help="只做統計和摘要")
    ap.add_argument("--top", type=int, default=6, help="摘要排行列幾名")
    ap.add_argument("--fps", type=float, default=8)
    ap.add_argument("--shp", default=str(config.ROOT / "shp"))
    ap.add_argument("--local", action="store_true", help="只用本機 data/,不從 R2 下載")
    a = ap.parse_args()
    use_r2 = not a.local
    start = to_stamp(parse_tw(a.start))
    end = event_stats.resolve_end(to_stamp(parse_tw(a.end)) if a.end else None, use_r2)

    geo = event_stats.load_shp(Path(a.shp))
    storms = storms_near(start, end, use_r2, geo) if a.kind != "rain" else []
    kind = a.kind if a.kind != "auto" else ("typhoon" if storms else "rain")
    name = a.name or (f"{storms[0]['name_zh']}颱風" if storms else "豪雨事件")
    print(f"事件:{name}({kind});颱風:{', '.join(s['name_zh'] for s in storms) or '無'}")

    out = event_stats.OUT_DIR / f"{tw(start, '%Y%m%d%H%M')}_{tw(end, '%Y%m%d%H%M')}_{name}"
    r = event_stats.run(start, end, Path(a.shp), use_r2, out)
    summary = summary_text(r, name, kind, storms, a.top)
    (out / "summary.txt").write_text(summary + "\n", encoding="utf-8")
    print(f"摘要 → {out / 'summary.txt'}")

    if a.no_video:
        return
    keys = a.videos.split(",") if a.videos else (list(VIDEOS) if kind == "typhoon" else ["radar"])
    results = {}
    for k in keys:
        print(f"影片 {k} …")
        try:
            results[k] = radar_video.render(start, end, use_r2=use_r2, fps=a.fps, shp=a.shp, out_dir=out, **VIDEOS[k])
        except ValueError as e:
            print(f"  略過:{e}")
    if results:
        (out / "youtube.txt").write_text(youtube_text(name, kind, results, summary, a.fps) + "\n", encoding="utf-8")
        print(f"YouTube 標題說明 → {out / 'youtube.txt'}")
    print(f"完成:{out}")


if __name__ == "__main__":
    main()

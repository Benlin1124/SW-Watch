// 衛星日夜 / 真實色用的太陽位置(合成在 pipeline/truecolor.py 做,這裡只給滑鼠讀值與圖例)

export const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));

// 日夜漸變:太陽仰角 night 以下全用夜間紅外線、day 以上全用白天可見光(度);夜間冷雲頂 cold[0]→cold[1] °C 漸變改用 B13
// (同 pipeline/truecolor.py 的 DN_NIGHT / DN_DAY / DN_COLD)
export const DN = { night: 0, day: 10, cold: [-30, -50] };

/** 太陽赤緯與時間(NOAA 近似式,含均時差);時間取掃描開始 + 5 分(全盤掃到台灣附近約這時候) */
export function sunAt(stamp) {
  const t = Date.UTC(+stamp.slice(0, 4), +stamp.slice(4, 6) - 1, +stamp.slice(6, 8), +stamp.slice(8, 10), +stamp.slice(10, 12) + 5);
  const d = new Date(t), doy = (t - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5;
  const min = d.getUTCHours() * 60 + d.getUTCMinutes();
  const gm = (2 * Math.PI / 365) * (doy + (min / 60 - 12) / 24);
  const eqt = 229.18 * (0.000075 + 0.001868 * Math.cos(gm) - 0.032077 * Math.sin(gm) - 0.014615 * Math.cos(2 * gm) - 0.040849 * Math.sin(2 * gm));
  const decl = 0.006918 - 0.399912 * Math.cos(gm) + 0.070257 * Math.sin(gm) - 0.006758 * Math.cos(2 * gm)
    + 0.000907 * Math.sin(2 * gm) - 0.002697 * Math.cos(3 * gm) + 0.00148 * Math.sin(3 * gm);
  return { decl, min: min + eqt };
}

/** 太陽仰角(度) */
export function sunElevation({ decl, min }, lat, lon) {
  const ha = (((min + 4 * lon) / 4 - 180) * Math.PI) / 180, p = (lat * Math.PI) / 180;
  return (Math.asin(Math.sin(p) * Math.sin(decl) + Math.cos(p) * Math.cos(decl) * Math.cos(ha)) * 180) / Math.PI;
}

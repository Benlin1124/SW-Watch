// 日夜合成在背景執行緒做(一張 B03 解析度約 1600 萬格,放主執行緒會讓地圖卡住)
// 收 { id, night, vis, sun } → 回 { id, rgba(已上下翻轉,可直接 putImageData), nx, ny, r03s(B03 縮成 B07 格點,沒有 B03 為 null) }
// 不在 worker 裡建畫布:5000×3240 的 OffscreenCanvas 在 worker 容易記憶體不足
import { dnCode, GRAY_LUT, halve } from './daynight.js';

self.onmessage = ({ data: { id, night, vis, sun } }) => {
  try {
    const { code, g } = dnCode(night, vis, sun);
    const rgba = new Uint8ClampedArray(g.nx * g.ny * 4), out = new Uint32Array(rgba.buffer);
    for (let y = 0; y < g.ny; y++) {               // 資料第 0 列在最南 → 畫到最下面
      const src = y * g.nx, dst = (g.ny - 1 - y) * g.nx;
      for (let x = 0; x < g.nx; x++) out[dst + x] = GRAY_LUT[code[src + x]];
    }
    const r03s = vis ? halve(vis.r03, vis.g03) : null;
    self.postMessage({ id, rgba, nx: g.nx, ny: g.ny, r03s }, [rgba.buffer, ...(r03s ? [r03s.buffer] : [])]);
  } catch (e) {
    self.postMessage({ id, error: String(e) });
  }
};

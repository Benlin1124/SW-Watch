// 時序圖的時間軸縮放(單點預報卡、測站卡共用):拖曳選範圍、滾輪以游標為中心縮放、雙指捏合 / 平移、雙擊還原。
// 建圖時 cursor 要 { drag: { x: true, y: false, setScale: true } }。
const MIN_SPAN = 3 * 3600;         // 最小看 3 小時

/** state = { xr: [min, max] | null }:換分頁重畫時留住範圍;回傳 wasDrag():剛才的點擊其實是拖曳(不要當成點選時刻) */
export function enableZoom(u, state) {
  const over = u.over, xs = () => u.data[0], lo = () => xs()[0], hi = () => xs()[xs().length - 1];
  u.root.chart = u;                // 除錯 / 測試用
  let busy = false;

  const apply = (a, b) => {
    const full = hi() - lo();
    let span = Math.max(Math.min(b - a, full), Math.min(MIN_SPAN, full));
    a = Math.min(Math.max(a, lo()), hi() - span);
    busy = true;
    u.setScale('x', { min: a, max: a + span });
    busy = false;
    state.xr = span >= full ? null : [a, a + span];
  };
  const reset = () => apply(lo(), hi());
  (u.hooks.setScale ??= []).push((_, key) => {               // 拖曳選範圍是 uPlot 自己設的
    if (key !== 'x' || busy) return;
    const { min, max } = u.scales.x;
    state.xr = max - min >= hi() - lo() ? null : [min, max];
  });

  over.addEventListener('wheel', (e) => {
    e.preventDefault();
    const { min, max } = u.scales.x, r = over.getBoundingClientRect();
    const f = (e.clientX - r.left) / r.width, k = e.deltaY > 0 ? 1.25 : 0.8, span = (max - min) * k, at = min + (max - min) * f;
    apply(at - span * f, at + span * (1 - f));
  }, { passive: false });
  over.addEventListener('dblclick', reset);

  // 雙指:捏合縮放、一起移動 = 平移;單指留給頁面捲動和游標
  let pinch = null;
  const touchInfo = (e) => {
    const [a, b] = e.touches, r = over.getBoundingClientRect();
    return { d: Math.max(Math.abs(a.clientX - b.clientX), 1), f: ((a.clientX + b.clientX) / 2 - r.left) / r.width };
  };
  over.style.touchAction = 'pan-y';
  over.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) pinch = { ...touchInfo(e), min: u.scales.x.min, max: u.scales.x.max };
  }, { passive: true });
  over.addEventListener('touchmove', (e) => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    const t = touchInfo(e), span = (pinch.max - pinch.min) * (pinch.d / t.d), at = pinch.min + (pinch.max - pinch.min) * pinch.f;
    apply(at - span * t.f, at + span * (1 - t.f));
  }, { passive: false });
  over.addEventListener('touchend', () => { pinch = null; });

  let downX = null, dragged = false;
  over.addEventListener('mousedown', (e) => { downX = e.clientX; dragged = false; });
  over.addEventListener('mouseup', (e) => { if (downX != null) dragged = Math.abs(e.clientX - downX) > 4; downX = null; });

  if (state.xr) apply(...state.xr);
  return () => dragged;
}

// 網頁設定存在瀏覽器(localStorage):圖層開關、透明度、變數、篩選、時間軸範圍、系集各模式、地圖位置…
// 重新整理後還原。只存「設定」,不存時間類選項(預報初始、系集初始時間等,下次打開已過時)。
const KEY = 'sw-watch-prefs-v1';
const SKIP = new Set(['st-search', 'ty-issue', 'ens-tc', 'ens-init', 'ens-valid-start', 'slider', 'ec-init', 'ec-step']);

function read() {
  try { return JSON.parse(localStorage.getItem(KEY)) ?? {}; } catch { return {}; }
}

let data = read();

function write() {
  try { localStorage.setItem(KEY, JSON.stringify(data)); } catch { /* 無痕視窗等:不存 */ }
}

export const get = (k) => data[k];
export function set(k, v) { data[k] = v; write(); }
export function reset() {
  data = {};
  try { localStorage.removeItem(KEY); } catch { /* 同上 */ }
}

/** 控制項的存檔名稱;沒有名稱的不存(拉桿旁的數字框、系集各模式列另外存) */
function keyOf(el) {
  if (el.id) return SKIP.has(el.id) ? null : el.id;
  if (el.dataset.tyCircle) return `ty-circle:${el.dataset.tyCircle}`;
  if (el.dataset.ensOpt) return `ens-opt:${el.dataset.ensOpt}`;
  if (el.closest('#st-types')) return `st-type:${el.value}`;
  if (el.type === 'radio' && el.name) return `radio:${el.name}:${el.value}`;
  return null;
}

const controls = () => [...document.querySelectorAll('#panel input, #panel select, #timeline select')]
  .filter((el) => !el.closest('#ens-models') && keyOf(el));
const valueOf = (el) => (el.type === 'checkbox' || el.type === 'radio' ? el.checked : el.value);

function saveControls() {
  const old = data.controls ?? {};
  data.controls = Object.fromEntries(controls().map((el) => {
    const k = keyOf(el);
    // 選項還沒載入的下拉(縣市):保留存檔值
    const keep = el.tagName === 'SELECT' && old[k] !== undefined && ![...el.options].some((o) => o.value === old[k]);
    return [k, keep ? old[k] : valueOf(el)];
  }));
  write();
}

/** 存檔裡和畫面不同的控制項:先全部設好,再依畫面順序觸發事件,讓各圖層套用 */
export function restoreControls() {
  const saved = data.controls ?? {};
  const changed = [];
  for (const el of controls()) {
    const v = saved[keyOf(el)];
    if (v === undefined || v === valueOf(el)) continue;
    if (el.tagName === 'SELECT' && ![...el.options].some((o) => o.value === v)) continue;
    if (el.type === 'checkbox' || el.type === 'radio') el.checked = v; else el.value = v;
    changed.push(el);
  }
  for (const el of changed) {
    if (el.type === 'radio' && !el.checked) continue;
    el.dispatchEvent(new Event(el.type === 'range' || el.type === 'number' ? 'input' : 'change', { bubbles: true }));
  }
  // 事件處理可能連帶改到其他控制項(例如排行順序跟著「最小」變),再設回存檔值
  for (const el of changed) {
    const v = saved[keyOf(el)];
    if (valueOf(el) !== v && el.tagName === 'SELECT') {
      el.value = v;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  saveControls();
}

/** 之後每次操作就存(事件冒泡到 document 時,各控制項自己的處理已經跑完) */
export function watchControls() {
  const h = (e) => { if (e.target.closest?.('#panel, #timeline')) saveControls(); };
  document.addEventListener('change', h);
  document.addEventListener('input', h);
}

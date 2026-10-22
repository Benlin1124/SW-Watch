// 讀取 pipeline 輸出的靜態檔:index.json、格點 .bin.gz、JSON
import { DATA_BASE_URL } from './config.js';

const url = (path) => new URL(path, DATA_BASE_URL).href;

/** index.json 會一直更新,加時間參數避免快取 */
export async function getIndex(layer) {
  const r = await fetch(url(`${layer}/index.json?t=${Date.now()}`));
  if (!r.ok) throw new Error(`${layer} index ${r.status}`);
  return r.json();
}

/** JSON;.json.gz(gzip 壓縮)也可以,自己解 */
export async function getJSON(path) {
  const r = await fetch(url(path));
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return JSON.parse(new TextDecoder().decode(await gunzip(await r.arrayBuffer())));
}

/** 伺服器若已幫忙解壓(Content-Encoding: gzip)就直接用,否則自己解 */
async function gunzip(buf) {
  const u8 = new Uint8Array(buf);
  if (u8[0] !== 0x1f || u8[1] !== 0x8b) return buf;
  const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

const TYPED = { uint8: Uint8Array, uint16: Uint16Array };

/** 格點原始整數陣列(第 0 列為最南);實際值 = raw * scale + offset,raw == nodata 為無資料 */
export async function getGrid(layer, stamp, spec) {
  const r = await fetch(url(`${layer}/${stamp}.bin.gz`));
  if (!r.ok) throw new Error(`${layer}/${stamp} ${r.status}`);
  const buf = await gunzip(await r.arrayBuffer());
  const arr = new TYPED[spec.dtype](buf);
  if (arr.length !== spec.nx * spec.ny) throw new Error(`${layer}/${stamp} 格點數不符`);
  return arr;
}

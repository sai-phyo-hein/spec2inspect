// @ts-check
// Recorded results (replay/index.json + replay/images/) and box images.
import { state } from "./state.js";
/** @typedef {import("../../types/model").Entry} Entry */
/** @typedef {import("../../types/model").ReplayIndex} ReplayIndex */
/** @typedef {import("../../types/model").BoxImage} BoxImage */

/** Loads the replay recorded on Kaggle; throws if this deployment has none. @param {string} [base] @returns {Promise<ReplayIndex>} */
export async function loadReplay(base = "replay") {
  const r = await fetch(`${base}/index.json`, { cache: "no-store" });
  if (!r.ok) throw new Error(`no replay at ${base}/ (HTTP ${r.status})`);
  /** @type {ReplayIndex} */ const idx = await r.json();
  state.entries = idx.entries;
  state.imgUrl = (e) => `${base}/images/${encodeURIComponent(e.entry)}.jpg`;
  state.playlist = buildPlaylist(idx.entries);
  return idx;
}

/**
 * Alternate good and anomalous boxes, a different colour/lighting variant each time; the missing-wall box second.
 * @param {Entry[]} entries @returns {Entry[]}
 */
export function buildPlaylist(entries) {
  /** @type {Map<string, Entry[]>} */ const byImg = new Map();
  for (const e of entries) { if (!byImg.has(e.img_id)) byImg.set(e.img_id, []); byImg.get(e.img_id)?.push(e); }
  const variants = (/** @type {string} */ i) => byImg.get(i) || [];
  const good = [...byImg.keys()].filter((i) => variants(i)[0].label === 0);
  const bad = [...byImg.keys()].filter((i) => variants(i)[0].label === 1);
  /** @type {string[]} */ const order = [];
  for (let k = 0; k < Math.max(good.length, bad.length); k++) { if (good[k]) order.push(good[k]); if (bad[k]) order.push(bad[k]); }
  const at = order.indexOf("logi_067");
  if (at > 1) { order.splice(at, 1); order.splice(1, 0, "logi_067"); }
  return order.map((img, k) => { const vs = variants(img); return vs[k % vs.length]; });
}

/** @type {Map<string, BoxImage>} */ const cache = new Map();
/** @param {string} src @returns {Promise<HTMLImageElement>} */
const loadImage = (src) => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src; });

/** The box photo as a canvas (needed for pixel colour measurement). @param {Entry} entry @returns {Promise<BoxImage>} */
export async function boxImage(entry) {
  const hit = cache.get(entry.entry);
  if (hit) return hit;
  if (!state.imgUrl) throw new Error("replay not loaded");
  const img = await loadImage(state.imgUrl(entry));
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
  canvas.getContext("2d")?.drawImage(img, 0, 0);
  /** @type {BoxImage} */
  const out = { canvas, variant: [entry.color, entry.stops], w: entry.w || img.naturalWidth, h: entry.h || img.naturalHeight };
  cache.set(entry.entry, out);
  return out;
}

/** Human-readable colour and lighting variant. @param {[string, number]} v */
export const variantText = (v) =>
  `${v[0] === "Random per pin" ? "mixed-colour" : v[0] === "Original" ? "original yellow" : v[0].toLowerCase()} pins, ` +
  `${!v[1] ? "normal light" : (v[1] < 0 ? "darker " : "brighter ") + (v[1] > 0 ? "+" : "") + v[1] + " stops"}`;

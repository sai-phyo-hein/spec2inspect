// @ts-check
// Live mode: the photo tray in the left panel. Sample photos plus every photo the user uploads; drag one onto the
// production line (or click it) to place it at the camera.
import { $ } from "./dom.js";
import { state } from "./state.js";
/** @typedef {import("../../types/model").TrayItem} TrayItem */

/** @type {TrayItem[]} */ const items = [];
/** @type {(item: TrayItem) => void} */ let onPick = () => {};

/** @param {TrayItem} item */
function thumb(item) {
  const b = document.createElement("button");
  b.type = "button"; b.className = "thumb" + (item.kind === "yours" ? " yours" : ""); b.draggable = true;
  b.title = `${item.name}: drag onto the line, or click, to inspect it`;
  b.innerHTML = `<img alt="" loading="lazy"><span class="tag2"></span>`;
  /** @type {HTMLImageElement} */ (b.querySelector("img")).src = item.url;
  /** @type {HTMLElement} */ (b.querySelector(".tag2")).textContent = item.kind === "yours" ? `yours · ${item.name}` : item.name;
  b.addEventListener("click", () => onPick(item));
  b.addEventListener("dragstart", (e) => {
    e.dataTransfer?.setData("text/plain", String(items.indexOf(item)));
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
    b.classList.add("dragging");
  });
  b.addEventListener("dragend", () => b.classList.remove("dragging"));
  return b;
}

function render() {
  const tray = $("tray"); tray.innerHTML = "";
  items.forEach((it) => tray.appendChild(thumb(it)));
  $("tray-hint").textContent = state.live ? `${items.length} photos · drag to the line` : "PLC events";
}

/** Add a photo to the front of the tray (uploads go first). @param {TrayItem} item */
export function addToTray(item) { items.unshift(item); render(); }

/** Sample photos: the public Hugging Face dataset via the API, or recorded boxes if it is unavailable. */
async function loadSamples() {
  try {
    const r = await fetch("api/samples", { cache: "no-store" });
    if (r.ok) {
      const d = await r.json();
      if (d.items?.length) { d.items.forEach((/** @type {TrayItem} */ it) => items.push({ ...it, kind: "sample" })); return; }
    }
  } catch (_) { /* fall back below */ }
  const originals = state.entries.filter((e) => e.color === "Original" && !e.stops);
  const good = originals.filter((e) => e.label === 0).slice(0, 4), bad = originals.filter((e) => e.label === 1).slice(0, 4);
  for (const e of [...good, ...bad]) items.push({ name: e.img_id, url: state.imgUrl ? state.imgUrl(e) : "", kind: "sample" });
}

/** Show the tray (Live) or the line log (Replay) in the left panel. @param {boolean} live */
export function showTray(live) {
  $("tab-photos").hidden = !live;
  select(live ? "photos" : "log");
}

/** @param {"photos" | "log"} tab */
function select(tab) {
  $("tray").hidden = tab !== "photos"; $("log").hidden = tab !== "log";
  for (const [id, on] of [["tab-photos", tab === "photos"], ["tab-log", tab === "log"]]) {
    const b = $(/** @type {string} */ (id)); b.classList.toggle("on", /** @type {boolean} */ (on)); b.setAttribute("aria-selected", String(on));
  }
  $("tray-hint").textContent = tab === "photos" ? `${items.length} photos · drag to the line` : "PLC events";
}

/** @param {(item: TrayItem) => void} pick called when a photo is dropped on the line or clicked */
export async function initTray(pick) {
  onPick = pick;
  $("tab-photos").addEventListener("click", () => select("photos"));
  $("tab-log").addEventListener("click", () => select("log"));
  const wrap = $("scene-wrap");                                 // the production line is the drop target
  wrap.addEventListener("dragover", (e) => { if (!state.live) return; e.preventDefault(); wrap.classList.add("dropping"); });
  wrap.addEventListener("dragleave", (e) => { if (!wrap.contains(/** @type {Node} */ (e.relatedTarget))) wrap.classList.remove("dropping"); });
  wrap.addEventListener("drop", (e) => {
    wrap.classList.remove("dropping");
    if (!state.live) return;
    e.preventDefault();
    const it = items[parseInt(e.dataTransfer?.getData("text/plain") || "-1", 10)];
    if (it) onPick(it);
  });
  await loadSamples();
  render();
}

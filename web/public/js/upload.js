// @ts-check
// Live mode: drop (or upload) a photo at the start of the conveyor. It travels to the camera and is inspected
// automatically with Gemma 4 on the GPU. The drop zone is disabled until that inspection is finished.
import { $, $button, $input } from "./dom.js";
import { log } from "./log.js";
import { spawnUpload } from "./scene.js";
import { initTray, addToTray } from "./tray.js";
import { approved } from "./spec.js";
/** @typedef {import("../../types/model").BoxImage} BoxImage */
/** @typedef {import("../../types/model").Entry} Entry */
/** @typedef {import("../../types/model").TrayItem} TrayItem */

const MAX_W = 1700;                               // same scale as the recorded images
let busy = false;                                 // a photo is on its way to, or at, the camera

/** Load a photo (same-origin or object URL) into a canvas, scaled to at most MAX_W wide. @param {string} url @returns {Promise<BoxImage>} */
async function readPhoto(url) {
  /** @type {HTMLImageElement} */
  const img = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error("not an image")); im.src = url; });
  const s = Math.min(1, MAX_W / img.naturalWidth);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.naturalWidth * s); canvas.height = Math.round(img.naturalHeight * s);
  canvas.getContext("2d")?.drawImage(img, 0, 0, canvas.width, canvas.height);
  return { canvas, variant: ["Uploaded", 0], w: canvas.width, h: canvas.height };
}

/**
 * Inspect a photo on the GPU: create a job, then poll until it finishes.
 * @param {BoxImage} image @param {(seconds: number) => void} onProgress @returns {Promise<Entry>}
 */
async function analyseOnGpu(image, onProgress) {
  const r = await fetch("api/live/jobs", { method: "POST", headers: { "Content-Type": "application/json" },
                                          body: JSON.stringify({ image: image.canvas.toDataURL("image/jpeg", 0.92),
                                                                 program: approved.program, questions: approved.ruleset.questions }) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
  const { id } = await r.json();
  const t0 = Date.now();
  while (Date.now() - t0 < 7 * 60000) {
    await new Promise((res) => setTimeout(res, 700));
    const j = await (await fetch(`api/live/jobs/${id}`, { cache: "no-store" })).json();
    onProgress(j.elapsed ?? (Date.now() - t0) / 1000);
    if (j.state === "done") return j.result;
    if (j.state === "error") throw new Error(j.error);
  }
  throw new Error("timed out waiting for the GPU");
}

/** @param {boolean} on */
function setBusy(on) {
  busy = on;
  $("drop-zone").classList.toggle("busy", on);
  $button("btn-upload").disabled = on;
  $("dz-text").textContent = on ? "Inspecting… wait for the result" : "Drop a photo here";
}

/** Put a photo on the infeed, unless the previous one is still being inspected. @param {TrayItem} item */
async function placePhoto(item) {
  if (busy) { log(`<span class="bad">wait until the current photo has been inspected</span>`); return; }
  setBusy(true);
  try {
    const image = await readPhoto(item.url);
    spawnUpload(image, item.name, (progress) => analyseOnGpu(image, progress), () => setBusy(false));
  } catch (e) {
    setBusy(false);
    log(`<span class="bad">could not open ${item.name}: ${e instanceof Error ? e.message : e}</span>`);
  }
}

export async function initUpload() {
  const input = $input("file-upload");
  $("btn-upload").addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    const file = input.files?.[0]; input.value = "";
    if (!file) return;
    /** @type {TrayItem} */
    const item = { name: file.name, url: URL.createObjectURL(file), kind: "yours" };   // kept for the session
    addToTray(item);
    placePhoto(item);
  });
  await initTray(placePhoto);
}

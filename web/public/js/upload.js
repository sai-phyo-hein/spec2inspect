// @ts-check
// Live mode: place a photo at the camera (from the tray or a new upload) and inspect it with Gemma 4 on the GPU
// when the user presses Inspect.
import { $, $button, $input } from "./dom.js";
import { state } from "./state.js";
import { log } from "./log.js";
import { requestUploadPlacement, cancelUploadPlacement } from "./scene.js";
import { promptUploaded, inspectUpload } from "./station.js";
import { initTray, addToTray } from "./tray.js";
/** @typedef {import("../../types/model").Box} Box */
/** @typedef {import("../../types/model").BoxImage} BoxImage */
/** @typedef {import("../../types/model").Entry} Entry */
/** @typedef {import("../../types/model").TrayItem} TrayItem */

const MAX_W = 1700;                               // same scale as the recorded images
/** @type {"idle" | "placing" | "placed" | "inspecting"} */ let phase = "idle";
/** @type {Box | null} */ let placed = null;

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

/** Put a tray photo at the camera, if the station is free for a new photo. @param {TrayItem} item */
async function placePhoto(item) {
  if (phase !== "idle") { log(`<span class="bad">finish inspecting the current photo first</span>`); return; }
  phase = "placing"; setButtons();
  try {
    const image = await readPhoto(item.url);
    state.hold = true; $("line-status").textContent = "HOLD · PLACING YOUR PHOTO";
    log(`<span class="info">${item.name}: holding the line and placing it at Cam 01</span>`);
    requestUploadPlacement(image, (box) => {
      placed = box; phase = "placed"; setButtons();
      $("line-status").textContent = "HOLD · PRESS INSPECT";
      promptUploaded(box);
    });
  } catch (e) {
    phase = "idle"; setButtons();
    log(`<span class="bad">could not open ${item.name}: ${e instanceof Error ? e.message : e}</span>`);
  }
}

/**
 * Inspect a photo on the GPU: create a job, then poll until it finishes.
 * @param {BoxImage} image @param {(seconds: number) => void} onProgress @returns {Promise<Entry>}
 */
async function analyseOnGpu(image, onProgress) {
  const r = await fetch("api/live/jobs", { method: "POST", headers: { "Content-Type": "application/json" },
                                          body: JSON.stringify({ image: image.canvas.toDataURL("image/jpeg", 0.92) }) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
  const { id } = await r.json();
  const t0 = Date.now();
  while (Date.now() - t0 < 7 * 60000) {
    await new Promise((res) => setTimeout(res, 1500));
    const j = await (await fetch(`api/live/jobs/${id}`, { cache: "no-store" })).json();
    onProgress(j.elapsed ?? (Date.now() - t0) / 1000);
    if (j.state === "done") return j.result;
    if (j.state === "error") throw new Error(j.error);
  }
  throw new Error("timed out waiting for the GPU");
}

function setButtons() {
  $button("btn-upload").disabled = phase !== "idle";
  $button("btn-inspect").disabled = phase !== "placed";
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
  $("btn-inspect").addEventListener("click", async () => {
    const box = placed; if (!box || !box.image) return;
    placed = null; phase = "inspecting"; setButtons();
    const image = box.image;
    await inspectUpload(box, (progress) => analyseOnGpu(image, progress));
    phase = "idle"; setButtons();
  });
  await initTray(placePhoto);
}

/** Leaving Live mode: drop a photo that is waiting to be placed or inspected. An inspection in progress finishes. */
export function cancelUpload() {
  if (phase === "placing") cancelUploadPlacement();
  if (phase === "placed" && placed) {
    placed.phase = "done"; placed.el.classList.add("gone"); placed = null; state.station = null;
  }
  if (phase === "placing" || phase === "placed") { state.hold = false; phase = "idle"; $("line-status").textContent = "RUNNING"; }
  setButtons();
}

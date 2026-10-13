// @ts-check
// Replay / Live switch. Replay: recorded inspections only. Live: the same line, plus Upload and Inspect for your own photo.
import { $, $button } from "./dom.js";
import { state } from "./state.js";
import { setMode, log } from "./log.js";
import { showTray } from "./tray.js";

export const SAMPLE_IMAGES_URL = "https://huggingface.co/datasets/saiphyohein/spec2inspect-images";
const sampleLink = `<a href="${SAMPLE_IMAGES_URL}" target="_blank" rel="noopener">Get sample images ↗</a>`;

let recordedDate = "";
/** @type {() => void} */ let onLeaveLive = () => {};

const notes = {
  replay: () => `<b>Replaying</b> Gemma 4 E4B answers recorded on Kaggle (${recordedDate}); rules re-applied live. ${sampleLink}`,
  live: () => `<b>LIVE:</b> drag a photo onto the line or upload one, then press <b>Inspect</b>. ${sampleLink}`,
};

/** @param {"replay" | "live"} mode */
function switchTo(mode) {
  if (mode === state.mode) return;
  if (mode === "replay") onLeaveLive();
  state.live = mode === "live";
  $("replay-ctl").hidden = mode === "live";
  $("live-ctl").hidden = mode === "replay";
  if (mode === "live") {                         // the recorded line keeps running underneath
    state.running = true; $button("btn-run").textContent = "Pause";
    fetch("api/live/warm", { method: "POST" }).catch(() => {});   // start the GPU now, quietly, so Inspect is fast
  }
  setMode(mode, notes[mode]());
  showTray(mode === "live");
  log(`<span class="info">${mode === "live" ? "live mode: upload a photo to inspect it on the GPU" : "replay mode: recorded inspections"}</span>`);
}

/**
 * @param {string} recorded date the replay was recorded
 * @param {() => void} leaveLive called when switching back to Replay (cancels a pending upload)
 */
export async function initModeSwitch(recorded, leaveLive) {
  recordedDate = recorded; onLeaveLive = leaveLive;
  setMode("replay", notes.replay());
  $("mode-replay").addEventListener("click", () => switchTo("replay"));
  $("mode-live").addEventListener("click", () => switchTo("live"));
  try {
    const st = await (await fetch("api/live/status", { cache: "no-store" })).json();
    if (st.available) { const b = $button("mode-live"); b.disabled = false; b.title = "Upload your own photo and inspect it with Gemma 4 on the GPU"; }
  } catch (_) { /* no GPU service behind this page: Live stays disabled */ }
}
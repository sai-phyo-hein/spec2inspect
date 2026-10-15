// @ts-check
// Replay / Live / Check switch. Replay: recorded inspections. Live: the same line, plus Upload and Inspect for your own
// photo. Check: the results of every photo inspected live.
import { $, $button } from "./dom.js";
import { state } from "./state.js";
import { setMode, log } from "./log.js";
import { showTray } from "./tray.js";
import { showCheck } from "./check.js";
import { clearRecorded } from "./scene.js";
import { showWaiting } from "./station.js";
import { refreshSpecView } from "./spec-view.js";

export const SAMPLE_IMAGES_URL = "https://huggingface.co/datasets/saiphyohein/spec2inspect-images";
const sampleLink = `<a href="${SAMPLE_IMAGES_URL}" target="_blank" rel="noopener">Get sample images ↗</a>`;

let recordedDate = "";

const notes = {
  replay: () => `<b>Replaying</b> Gemma 4 E4B answers recorded on Kaggle (${recordedDate}); rules re-applied live. ${sampleLink}`,
  live: () => `<b>LIVE:</b> drag a photo onto the drop zone at the infeed, or upload one: it is inspected when it reaches the camera. ${sampleLink}`,
  check: () => `<b>CHECK:</b> every photo inspected live, from the shared inspection log, with the rules that applied. ${sampleLink}`,
};
let wasRunning = true;                                // the line pauses while the Check page is open

/** @param {import("../../types/model").Mode} mode */
function switchTo(mode) {
  if (mode === state.mode) return;
  const from = state.mode;
  if (from === "check") state.running = wasRunning;
  if (mode === "check") { wasRunning = state.running; state.running = false; }
  state.live = mode === "live";
  showCheck(mode === "check");
  $("replay-ctl").hidden = mode !== "replay";
  $("live-status").hidden = mode !== "live";
  $("drop-zone").hidden = mode !== "live";
  if (mode === "live") {                         // only the user's photos: take the recorded boxes off the line
    clearRecorded(); showWaiting();
    state.running = true; $button("btn-run").textContent = "Pause";
    fetch("api/live/warm", { method: "POST" }).catch(() => {});   // start the GPU now, quietly, so the first photo is fast
  }
  if (mode === "replay") $button("btn-run").textContent = state.running ? "Pause" : "Run";
  setMode(mode, notes[mode]());
  refreshSpecView();                               // Replay: fixed rules; Live: the approved specification
  showTray(mode === "live");
  if (mode !== "check")
    log(`<span class="info">${mode === "live" ? "live mode: drop a photo at the infeed to inspect it on the GPU" : "replay mode: recorded inspections"}</span>`);
}

/**
 * @param {string} recorded date the replay was recorded
 */
export async function initModeSwitch(recorded) {
  recordedDate = recorded;
  setMode("replay", notes.replay());
  $("mode-replay").addEventListener("click", () => switchTo("replay"));
  $("mode-live").addEventListener("click", () => switchTo("live"));
  $("mode-check").addEventListener("click", () => switchTo("check"));
  try {
    const st = await (await fetch("api/live/status", { cache: "no-store" })).json();
    if (st.available) { const b = $button("mode-live"); b.disabled = false; b.title = "Upload your own photo and inspect it with Gemma 4 on the GPU"; }
  } catch (_) { /* no GPU service behind this page: Live stays disabled */ }
}

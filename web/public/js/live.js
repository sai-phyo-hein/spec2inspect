// @ts-check
// Live mode: wake the GPU service, then analyse each clamped box now with Gemma 4 on Cloud Run.
import { $, $button } from "./dom.js";
import { LIVE_MAX_MIN } from "./config.js";
import { state } from "./state.js";
import { log, updateKpis, setMode } from "./log.js";
/** @typedef {import("../../types/model").Entry} Entry */

/** @type {ReturnType<typeof setTimeout> | undefined} */ let timer;

/** @param {"warming" | "on" | "off"} kind */
function setButton(kind) {
  const btn = $button("btn-live"); btn.classList.remove("warming", "on");
  if (kind === "warming") { btn.classList.add("warming"); $("live-text").textContent = "Starting GPU…"; btn.disabled = true; }
  else if (kind === "on") { btn.classList.add("on"); $("live-text").textContent = "Stop live"; btn.disabled = false; }
  else { $("live-text").textContent = "Live"; btn.disabled = false; }
}

async function start() {
  setButton("warming"); log(`<span class="info">live: starting the GPU service…</span>`);
  try {
    const r = await (await fetch("api/live/warm", { method: "POST" })).json();
    if (!r.ready) throw new Error("GPU not ready");
    state.live = true;
    setMode("live", `<b>LIVE:</b> every box is analysed now by Gemma 4 E4B on the Cloud Run GPU; rules applied as written. Stops by itself after ${LIVE_MAX_MIN} min.`);
    setButton("on"); log(`<span class="info">live: GPU ready after ${r.seconds}s — boxes are now analysed live</span>`);
    Object.assign(state, { inspected: 0, passed: 0, failed: 0, agreeN: 0, agreeOk: 0, runMs: 0 }); updateKpis();
    timer = setTimeout(() => stop(`live stopped after ${LIVE_MAX_MIN} min (cost guard)`), LIVE_MAX_MIN * 60000);
  } catch (e) {
    setButton("off"); log(`<span class="bad">live: could not start the GPU (${e instanceof Error ? e.message : e})</span>`);
  }
}

/** @param {string} [msg] */
function stop(msg) {
  state.live = false; clearTimeout(timer); setButton("off");
  setMode("replay", state.replayNote); log(`<span class="info">${msg || "live stopped — back to the recorded replay"}</span>`);
}

/** Enable the Live button if this deployment offers a GPU service. */
export async function initLive() {
  const btn = $button("btn-live");
  btn.addEventListener("click", () => (state.live ? stop() : start()));
  try {
    const st = await (await fetch("api/live/status", { cache: "no-store" })).json();
    if (st.available) { btn.disabled = false; btn.title = "Analyse each box now with Gemma 4 on the Cloud Run GPU"; }
  } catch (_) { /* no live service behind this page */ }
}

/** Real Gemma answers for one box, computed now on the GPU. @param {Entry} entry @returns {Promise<Entry>} */
export function liveAnalyse(entry) {
  return fetch("api/live/inspect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ entry: entry.entry }) })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))));
}

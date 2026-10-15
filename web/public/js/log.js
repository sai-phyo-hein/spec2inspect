// @ts-check
// Line event log, KPI bar and the Replay / Live switch state.
import { $ } from "./dom.js";
import { state } from "./state.js";

/** Add a line to the event log (newest first, last 80 kept). @param {string} html */
export function log(html) {
  const ul = $("log"), li = document.createElement("li");
  li.innerHTML = `<span>${new Date().toTimeString().slice(0, 8)}</span><span>${html}</span>`;
  ul.prepend(li);
  while (ul.children.length > 80) ul.lastChild?.remove();
}

export function updateKpis() {
  $("k-insp").textContent = String(state.inspected);
  $("k-pass").textContent = String(state.passed);
  $("k-fail").textContent = String(state.failed);
  $("k-agree").textContent = state.agreeN ? `${state.agreeOk}/${state.agreeN}` : "–";
  $("k-rate").textContent = state.runMs > 1000 ? (state.inspected / (state.runMs / 60000)).toFixed(1) : "0.0";
  $("bin-good").textContent = String(state.binGood);
  $("bin-rej").textContent = String(state.binRej);
}

/** Show the mode on the switch and the matching note in the footer. @param {import("../../types/model").Mode} mode @param {string} note */
export function setMode(mode, note) {
  state.mode = mode;
  for (const [id, on] of [["mode-replay", mode === "replay"], ["mode-live", mode === "live"], ["mode-check", mode === "check"]]) {
    const b = $(/** @type {string} */ (id)); b.classList.toggle("on", /** @type {boolean} */ (on)); b.setAttribute("aria-checked", String(on));
  }
  $("mode-note").innerHTML = note; $("mode-note").dataset.line = note;
}

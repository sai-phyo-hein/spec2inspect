// @ts-check
// Entry point: wire the modules together and start the line.
import { $, $select } from "./dom.js";
import { state } from "./state.js";
import { createRuleSet } from "./rules.js";
import { loadReplay } from "./data.js";
import { drawMatrix } from "./panel.js";
import { initSpecEditor } from "./spec-editor.js";
import { initLive } from "./live.js";
import { initStation, inspect, reapplyRules } from "./station.js";
import { startLine } from "./scene.js";
import { setMode, log } from "./log.js";

const rules = createRuleSet();
initSpecEditor(rules, reapplyRules);
initStation(rules);
drawMatrix(null, 0);

$("btn-run").addEventListener("click", () => {
  state.running = !state.running;
  $("btn-run").textContent = state.running ? "Pause" : "Run";
  $("line-status").textContent = state.running ? (state.station ? "CLAMPED · INSPECTING" : "RUNNING") : "PAUSED";
});
$select("speed").addEventListener("change", (e) => { state.speed = parseFloat(/** @type {HTMLSelectElement} */ (e.target).value); });

try {
  const idx = await loadReplay();
  state.replayNote = `<b>Replaying</b> Gemma 4 E4B answers recorded on Kaggle (${(idx.recorded || "").slice(0, 10)}); ` +
                     `rules re-applied live. <a href="inspect/">Inspect your own photo →</a>`;
  setMode("replay", state.replayNote);
  await initLive();
  startLine(inspect);
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  setMode("replay", `<b>No recorded results found.</b> ${msg}`);
  log(`<span class="bad">${msg}</span>`);
}

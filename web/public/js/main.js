// @ts-check
// Entry point: wire the modules together and start the line.
import { $, $select } from "./dom.js";
import { state } from "./state.js";
import { loadReplay } from "./data.js";
import { drawMatrix } from "./panel.js";
import { initModeSwitch } from "./mode.js";
import { initUpload } from "./upload.js";
import { initCheck } from "./check.js";
import { inspect, inspectUpload } from "./station.js";
import { loadApproved } from "./spec.js";
import { initSpecView } from "./spec-view.js";
import { initAdmin } from "./admin.js";
import { initViewSwitch } from "./view.js";
import { trayItems } from "./tray.js";
import { startLine } from "./scene.js";
import { setMode, log } from "./log.js";

initSpecView();
drawMatrix(null, 0);

$("btn-run").addEventListener("click", () => {
  state.running = !state.running;
  $("btn-run").textContent = state.running ? "Pause" : "Run";
  $("line-status").textContent = state.running ? (state.station ? "CLAMPED · INSPECTING" : "RUNNING") : "PAUSED";
});
$select("speed").addEventListener("change", (e) => { state.speed = parseFloat(/** @type {HTMLSelectElement} */ (e.target).value); });

/** Run one part of the page's set-up; a failure there is reported but doesn't stop the production line. @param {string} name @param {() => any} fn */
async function part(name, fn) {
  try { await fn(); }
  catch (e) { const msg = e instanceof Error ? e.message : String(e); console.error(name, e); log(`<span class="bad">${name} could not start: ${msg}</span>`); }
}

try {
  const idx = await loadReplay();
  await loadApproved();                              // the line runs the latest approved specification
  startLine((b) => {                                 // the line first: a box reached the camera
    if (!b.upload) { inspect(b); return; }
    const analyse = b.analyse;
    if (analyse) inspectUpload(b, analyse).finally(() => b.onDone?.());
  });
  await part("Live photos", () => initUpload());
  await part("Check page", () => initCheck());
  await part("Mode switch", () => initModeSwitch((idx.recorded || "").slice(0, 10)));
  await part("View menu", () => initViewSwitch());
  await part("Admin page", () => initAdmin(trayItems().filter((t) => t.kind === "sample")));
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  setMode("replay", `<b>No recorded results found.</b> ${msg}`);
  log(`<span class="bad">${msg}</span>`);
}
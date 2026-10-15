// @ts-check
// Production line / Admin view, chosen from the settings menu at the top right. The gear rotates when the menu opens.
// Admin hides the line (and pauses it), the line metrics and the Replay/Live/Check switch, and shows the rule builder.
import { $ } from "./dom.js";
import { state } from "./state.js";
import { showCheck } from "./check.js";

let wasRunning = true;
/** @type {"line" | "admin"} */ let current = "line";

/** @param {boolean} open */
function setMenu(open) {
  $("view-toggle").setAttribute("aria-expanded", String(open));
  $("view-list").hidden = !open;
}

/** @param {"line" | "admin"} view */
function switchView(view) {
  setMenu(false);
  if (view === current) return;
  current = view;
  const admin = view === "admin";
  $("view-label").textContent = admin ? "Admin" : "Production line";
  $("view-menu").classList.toggle("admin", admin);
  document.querySelectorAll("#view-list [data-view]").forEach((b) => b.setAttribute("aria-checked", String(/** @type {HTMLElement} */ (b).dataset.view === view)));
  $("mode-switch").hidden = admin;
  $("kpis").hidden = admin;                        // line metrics don't belong on the rule builder
  $("admin-page").hidden = !admin;
  if (admin) {
    wasRunning = state.running; state.running = false;
    $("line-layout").hidden = true; $("check-page").hidden = true;
    $("mode-note").innerHTML = "<b>ADMIN:</b> specification and sample in, region plan and rules JSON out, verified on the sample and for accuracy, then approved. The line runs only approved versions.";
  } else {
    state.running = wasRunning;
    showCheck(state.mode === "check");
    $("mode-note").innerHTML = $("mode-note").dataset.line || "";
  }
}

export function initViewSwitch() {
  $("view-toggle").addEventListener("click", (e) => { e.stopPropagation(); setMenu($("view-list").hidden); });
  document.querySelectorAll("#view-list [data-view]").forEach((b) =>
    b.addEventListener("click", () => switchView(/** @type {"line" | "admin"} */ (/** @type {HTMLElement} */ (b).dataset.view))));
  document.addEventListener("click", (e) => { if (!$("view-menu").contains(/** @type {Node} */ (e.target))) setMenu(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") setMenu(false); });
}

// @ts-check
// The Check page: every uploaded photo inspected live, with its verdict, findings and the rules that applied.
import { $ } from "./dom.js";
import { getChecks, clearChecks, onChecksChanged, checksCsv } from "./history.js";
/** @typedef {import("../../types/model").CheckRecord} CheckRecord */

/** @type {"all" | "pass" | "fail"} */ let filter = "all";

const esc = (/** @type {string} */ s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] || c);

/** @param {CheckRecord} r */
function card(r) {
  const t = new Date(r.at);
  const grid = r.counts.map((n) => `<span>${esc(n)}</span>`).join("");
  return `<article class="check-card ${r.failed ? "fail" : "pass"}">
    <img src="${r.thumb}" alt="${esc(r.name)} with its inspection overlay">
    <div class="check-body">
      <div class="check-top"><span class="check-verdict">${r.failed ? "FAIL" : "PASS"}</span>
        <span class="mono check-meta">${t.toLocaleDateString()} ${t.toTimeString().slice(0, 8)}${r.seconds != null ? ` · ${r.seconds}s on GPU` : ""}</span></div>
      <div class="check-name" title="${esc(r.name)}">${esc(r.name)}</div>
      <div class="check-grid" aria-label="Pins counted per compartment">${grid}</div>
      ${r.findings.length ? `<ul class="check-findings">${r.findings.slice(0, 4).map((f) => `<li>${esc(f)}</li>`).join("")}${r.findings.length > 4 ? `<li>+ ${r.findings.length - 4} more</li>` : ""}</ul>`
                          : `<p class="check-ok">All written rules satisfied.</p>`}
      <details class="check-rules"><summary>Rules applied (${r.rules.length})</summary><ul>${r.rules.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></details>
    </div></article>`;
}

function render() {
  const all = getChecks();
  const shown = all.filter((r) => filter === "all" || (filter === "fail") === r.failed);
  const fails = all.filter((r) => r.failed).length, secs = all.map((r) => r.seconds).filter((x) => x != null);
  $("ck-total").textContent = String(all.length);
  $("ck-pass").textContent = String(all.length - fails);
  $("ck-fail").textContent = String(fails);
  $("ck-secs").textContent = secs.length ? (secs.reduce((a, b) => a + /** @type {number} */ (b), 0) / secs.length).toFixed(1) + "s" : "–";
  document.querySelectorAll("#check-filter button").forEach((b) => b.classList.toggle("on", /** @type {HTMLElement} */ (b).dataset.f === filter));
  $("check-list").innerHTML = shown.length ? shown.map(card).join("")
    : `<p class="check-empty">${all.length ? "No results match this filter." : "No uploaded photos inspected yet. Switch to <b>Live</b>, drag a photo onto the line or upload one, and press <b>Inspect</b>."}</p>`;
}

export function initCheck() {
  document.querySelectorAll("#check-filter button").forEach((b) => b.addEventListener("click", () => {
    filter = /** @type {"all" | "pass" | "fail"} */ (/** @type {HTMLElement} */ (b).dataset.f); render();
  }));
  $("ck-csv").addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([checksCsv()], { type: "text/csv" }));
    a.download = `spec2inspect-checks-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $("ck-clear").addEventListener("click", () => { if (confirm("Clear all inspection results on this device?")) clearChecks(); });
  onChecksChanged(render);
  render();
}

/** Show the Check page instead of the line (or the line again). @param {boolean} on */
export function showCheck(on) {
  $("line-layout").hidden = on;
  $("check-page").hidden = !on;
  if (on) render();
}
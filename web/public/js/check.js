// @ts-check
// The Check page: every uploaded photo inspected live, with its verdict, findings and the rules that applied.
import { $ } from "./dom.js";
import { getChecks, clearChecks, onChecksChanged, checksCsv, refreshChecks, isShared } from "./history.js";
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
      <details class="check-rules"><summary>Rules applied (${r.rules.length})${r.spec_version ? ` · spec v${r.spec_version}` : ""}</summary><ul>${r.rules.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></details>
    </div></article>`;
}

/** "Today", "Yesterday", or e.g. "Mon, 12 Oct 2026". @param {Date} d */
function dayLabel(d) {
  const day = (/** @type {Date} */ x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(new Date()) - day(d)) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

/** Records grouped by local calendar day, newest day first (records are already newest first). @param {CheckRecord[]} list */
function byDay(list) {
  /** @type {Map<string, CheckRecord[]>} */ const groups = new Map();
  for (const r of list) {
    const d = new Date(r.at), key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)?.push(r);
  }
  return [...groups.values()];
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
  $("ck-clear").hidden = isShared();                // the shared log can't be wiped from a public page
  $("ck-source").textContent = isShared() ? "shared inspection log" : "this browser only";
  $("check-list").innerHTML = shown.length
    ? byDay(shown).map((g) => {
        const rej = g.filter((r) => r.failed).length;
        return `<h3 class="check-day">${dayLabel(new Date(g[0].at))}<span>${g.length} photo${g.length === 1 ? "" : "s"} · ${rej} rejected</span></h3>` +
               g.map(card).join("");
      }).join("")
    : `<p class="check-empty">${all.length ? "No results match this filter." : "No photos inspected live yet. Switch to <b>Live</b>, drag a photo onto the line or upload one, and press <b>Inspect</b>."}</p>`;
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
  if (on) { render(); refreshChecks(); }            // show what we have, then the latest shared log
}

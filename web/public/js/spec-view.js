// @ts-check
// The production line's specification card: the approved rules, read-only, with version and accuracy.
import { $ } from "./dom.js";
import { RULE_DEFS, describeRule } from "./rules.js";
import { approved, onApprovedChanged } from "./spec.js";

const esc = (/** @type {string} */ s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] || c);

function render() {
  const items = approved.rules.items.filter((r) => r.on);
  $("line-rules").innerHTML = items.map((r, i) => {
    const def = RULE_DEFS[r.type];
    return `<li class="rule ro"><span class="txt"><b class="mono">R${i + 1}</b>${esc(describeRule(r))} <span class="tag">${def.k || "Gemma"}</span></span></li>`;
  }).join("");
  const when = approved.approved_at ? new Date(approved.approved_at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
  $("spec-badge").textContent = approved.version ? `approved v${approved.version} · ${when}` : "default spec · not yet approved";
  $("line-thr").textContent = approved.threshold.toFixed(2);
  $("line-plan").textContent = `${approved.layout.rows} × ${approved.layout.cols} regions · region program v1`;
  const a = approved.accuracy;
  $("line-acc").textContent = a ? `accuracy ${(a.accuracy * 100).toFixed(1)}%${a.auroc != null ? ` · AUROC ${(a.auroc * 100).toFixed(1)}` : ""}` : "accuracy not measured";
}

export function initSpecView() { onApprovedChanged(render); render(); }

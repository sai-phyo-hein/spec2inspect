// @ts-check
// The production line's specification card: the approved rules, read-only, plus controls for the values the rule set
// lets the operator change (e.g. the colour to check, or the pins per compartment).
import { $ } from "./dom.js";
import { COLOURS } from "./rules.js";
import { ruleText, checkerOf, paramValues } from "./ruleset.js";
import { approved, onApprovedChanged, setOperatorValue } from "./spec.js";

const esc = (/** @type {string} */ s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] || c);

function render() {
  const rs = approved.ruleset, values = paramValues(rs, approved.operator);
  const rows = rs.rules.filter((r) => r.on !== false).map((r) =>
    `<li class="rule ro"><span class="txt"><b class="mono">${esc(r.id)}</b>${esc(ruleText(r))} <span class="tag">${esc(checkerOf(r))}</span></span></li>`);
  const ops = Object.entries(rs.params).filter(([, p]) => p.operator).map(([name, p]) => {
    const v = values[name], label = esc(p.label || name);
    const control = p.kind === "colour"
      ? `<select class="inl op" data-name="${esc(name)}">${COLOURS.map((c) => `<option${c === v ? " selected" : ""}>${c}</option>`).join("")}</select>`
      : `<input class="op" type="number" min="0" max="99" value="${v}" data-name="${esc(name)}" aria-label="${label}">`;
    return `<label class="op-setting">${label} ${control}</label>`;
  });
  $("line-rules").innerHTML = rows.join("") +
    (ops.length ? `<li class="rule ro op-row"><span class="tag op-tag">operator</span>${ops.join("")}</li>` : "");
  $("line-rules").querySelectorAll(".op").forEach((el) => el.addEventListener("change", () => {
    const c = /** @type {HTMLInputElement | HTMLSelectElement} */ (el), name = c.dataset.name || "";
    setOperatorValue(name, rs.params[name].kind === "colour" ? c.value : parseInt(c.value || "0", 10));
  }));
  const when = approved.approved_at ? new Date(approved.approved_at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
  $("spec-badge").textContent = approved.version ? `approved v${approved.version} · ${when}` : "default spec · not yet approved";
  $("line-thr").textContent = rs.sensitivity.toFixed(2);
  $("line-plan").textContent = `${approved.layout.rows} × ${approved.layout.cols} regions · region program v1`;
  const a = approved.accuracy;
  $("line-acc").textContent = a ? `accuracy ${(a.accuracy * 100).toFixed(1)}%${a.auroc != null ? ` · AUROC ${(a.auroc * 100).toFixed(1)}` : ""}` : "accuracy not measured";
}

export function initSpecView() { onApprovedChanged(render); render(); }

// @ts-check
// The written-specification card: render the rules, edit / add / remove them, sensitivity slider.
import { $, $input, $select } from "./dom.js";
import { RULE_DEFS, COLOURS } from "./rules.js";
/** @typedef {import("../../types/model").Rule} Rule */
/** @typedef {import("../../types/model").RuleSet} RuleSet */
/** @typedef {import("../../types/model").RuleType} RuleType */
/** @typedef {import("../../types/model").RuleParams} RuleParams */

/** @type {RuleSet | null} */ let ruleSet = null;
let onChange = () => {};

/** Current sensitivity: flag a compartment when P(violation) exceeds this. */
export const getThreshold = () => parseFloat($input("thr").value);

/** @param {Rule} rule @param {string} k @returns {string} */
function field(rule, k) {
  /** @param {(string | number)[]} vals @param {string | number | undefined} cur */
  const options = (vals, cur) => vals.map((v) => `<option${v === cur ? " selected" : ""}>${v}</option>`).join("");
  if (k === "r") return `<select class="inl" data-k="r">${options([1, 2, 3], rule.p.r)}</select>`;
  if (k === "c") return `<select class="inl" data-k="c">${options([1, 2, 3, 4, 5], rule.p.c)}</select>`;
  if (k === "col") return `<select class="inl" data-k="col">${options(COLOURS, rule.p.col)}</select>`;
  const value = rule.p[/** @type {keyof RuleParams} */ (k)];
  return `<input type="number" data-k="${k}" min="0" max="99" value="${value ?? 0}" aria-label="${k}">`;
}

function render() {
  const set = ruleSet; if (!set) return;
  const ul = $("rules"); ul.innerHTML = "";
  set.items.forEach((rule, i) => {
    const li = document.createElement("li");
    li.className = "rule" + (rule.on ? "" : " off");
    const def = RULE_DEFS[rule.type];
    const txt = def.t.replace(/\{(\w+)\}/g, (_, k) => field(rule, k)) + ` <span class="tag">${def.k || "Gemma"}</span>`;
    li.innerHTML = `<input type="checkbox" class="switch" ${rule.on ? "checked" : ""} aria-label="Rule R${i + 1} on">
      <span class="txt"><b class="mono">R${i + 1}</b>${txt}</span>
      <button type="button" class="rm" title="Remove rule" aria-label="Remove rule R${i + 1}">×</button>`;
    li.querySelector(".switch")?.addEventListener("change", (e) => {
      rule.on = /** @type {HTMLInputElement} */ (e.target).checked; li.classList.toggle("off", !rule.on); onChange();
    });
    li.querySelectorAll("[data-k]").forEach((node) => node.addEventListener("input", () => {
      const el = /** @type {HTMLInputElement | HTMLSelectElement} */ (node);
      const key = /** @type {keyof RuleParams} */ (el.dataset.k);
      if (key === "col") rule.p.col = el.value;
      else rule.p[key] = parseInt(el.value || "0", 10);
      onChange();
    }));
    li.querySelector(".rm")?.addEventListener("click", () => { set.remove(rule); render(); onChange(); });
    ul.appendChild(li);
  });
}

/** @param {RuleSet} rules @param {() => void} changed called after every edit */
export function initSpecEditor(rules, changed) {
  ruleSet = rules;
  onChange = () => { $("thr-v").textContent = getThreshold().toFixed(2); changed(); };
  $("add-rule").addEventListener("click", () => {
    rules.add(/** @type {RuleType} */ ($select("new-type").value)); render(); onChange(); $("rules").scrollTop = 1e6;
  });
  $("thr").addEventListener("input", onChange);
  render();
}

/** Replace all rules (e.g. a SKU loaded from the library, or a spec compiled by Gemini). @param {{type: RuleType, p?: RuleParams, on?: boolean}[]} items */
export function replaceRules(items) {
  const set = ruleSet; if (!set) return;
  set.items = []; set.seq = 0;
  items.forEach((r) => { set.add(r.type, r.p); set.items[set.items.length - 1].on = r.on !== false; });
  render(); onChange();
}

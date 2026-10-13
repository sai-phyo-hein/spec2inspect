// @ts-check
// Results of uploaded photos inspected live, for the Check page. Kept in memory and in localStorage (last 40).
import { renderOverlay } from "./panel.js";
import { RULE_DEFS } from "./rules.js";
/** @typedef {import("../../types/model").Box} Box */
/** @typedef {import("../../types/model").Rule} Rule */
/** @typedef {import("../../types/model").CheckRecord} CheckRecord */

const KEY = "spec2inspect.checks.v1", MAX = 40;
/** @type {CheckRecord[]} */ let records = load();
/** @type {Set<() => void>} */ const listeners = new Set();

/** @returns {CheckRecord[]} */
function load() {
  try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch (_) { return []; }
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(records)); }
  catch (_) { records = records.slice(0, Math.floor(records.length / 2)); try { localStorage.setItem(KEY, JSON.stringify(records)); } catch (__) { /* storage full or blocked */ } }
}

/** The rule set as plain sentences, as it stood when the photo was inspected. @param {Rule[]} rules */
function describeRules(rules) {
  return rules.filter((r) => r.on).map((r, i) => `R${i + 1}: ` + RULE_DEFS[r.type].t.replace(/\{(\w+)\}/g, (_, k) => String(r.p[/** @type {keyof typeof r.p} */ (k)] ?? "")));
}

/** Record a finished live inspection. @param {Box} b @param {Rule[]} rules */
export function recordCheck(b, rules) {
  if (!b.result || !b.image) return;
  const W = 480, H = Math.round(W * b.image.h / b.image.w);
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const ctx = c.getContext("2d"); if (!ctx) return;
  renderOverlay(ctx, W, b, 3);
  records.unshift({
    id: `${Date.now()}-${b.id}`, at: new Date().toISOString(), name: b.name || "uploaded photo",
    thumb: c.toDataURL("image/jpeg", 0.8),
    failed: b.result.failed, findings: b.result.findings.map((f) => f.replace(/<[^>]+>/g, "")),
    counts: b.result.cells.map((x) => x.count), seconds: b.liveSeconds ?? null, rules: describeRules(rules),
  });
  records = records.slice(0, MAX);
  save(); listeners.forEach((f) => f());
}

export const getChecks = () => records;
export function clearChecks() { records = []; save(); listeners.forEach((f) => f()); }
/** @param {() => void} f */ export function onChecksChanged(f) { listeners.add(f); }

/** CSV of all records (one row per photo). */
export function checksCsv() {
  const q = (/** @type {string} */ v) => `"${String(v).replace(/"/g, '""')}"`;
  const rows = [["time", "photo", "verdict", "seconds", "counts (row by row)", "findings", "rules"].map(q).join(",")];
  for (const r of records) rows.push([r.at, r.name, r.failed ? "FAIL" : "PASS", r.seconds ?? "", r.counts.join(" "),
                                      r.findings.join(" | "), r.rules.join(" | ")].map((v) => q(String(v))).join(","));
  return rows.join("\n");
}
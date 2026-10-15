// @ts-check
// Results of uploaded photos inspected live, for the Check page. Shared through the inspection log on the server
// (Firestore on Cloud Run); this browser also keeps its own last 40 in localStorage, used when the log is unreachable.
import { renderOverlay } from "./panel.js";
import { describeRule } from "./rules.js";
/** @typedef {import("../../types/model").Box} Box */
/** @typedef {import("../../types/model").Rule} Rule */
/** @typedef {import("../../types/model").CheckRecord} CheckRecord */

const KEY = "spec2inspect.checks.v1", MAX = 40;
/** @type {CheckRecord[]} */ let records = load();
/** @type {CheckRecord[] | null} */ let shared = null;      // the shared log, once fetched
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
  return rules.filter((r) => r.on).map((r, i) => `R${i + 1}: ${describeRule(r)}`);
}

/** Record a finished live inspection. @param {Box} b @param {Rule[]} rules @param {number} [specVersion] */
export function recordCheck(b, rules, specVersion) {
  if (!b.result || !b.image) return;
  const W = 480, H = Math.round(W * b.image.h / b.image.w);
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const ctx = c.getContext("2d"); if (!ctx) return;
  renderOverlay(ctx, W, b, 3);
  /** @type {CheckRecord} */
  const rec = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: new Date().toISOString(), name: b.name || "uploaded photo",
    thumb: c.toDataURL("image/jpeg", 0.8),
    failed: b.result.failed, findings: b.result.findings.map((f) => f.replace(/<[^>]+>/g, "")),
    counts: b.result.cells.map((x) => x.count), seconds: b.liveSeconds ?? null, rules: describeRules(rules),
    spec_version: specVersion || null,
  };
  records.unshift(rec); records = records.slice(0, MAX); save();
  if (shared) shared.unshift(rec);
  fetch("api/checks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(rec) })
    .catch(() => { /* kept locally; the shared log is unreachable */ });
  listeners.forEach((f) => f());
}

/** Fetch the shared inspection log (falls back to this browser's records). */
export async function refreshChecks() {
  try {
    const r = await fetch("api/checks?limit=200", { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    shared = (await r.json()).items;
  } catch (_) { shared = null; }
  listeners.forEach((f) => f());
}

/** True when the Check page shows the shared log rather than only this browser's results. */
export const isShared = () => shared !== null;
export const getChecks = () => shared ?? records;
/** Clears this browser's own copy (the shared log is not cleared from the page). */
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

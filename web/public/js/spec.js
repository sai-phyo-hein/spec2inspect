// @ts-check
// The approved specification the production line runs: the region program (how photos are divided), the rules and
// the sensitivity. Built and approved on the Admin page; versioned on the server (Firestore). Until something is
// approved, the built-in default applies.
import { createRuleSet } from "./rules.js";
import { WALL_MIN, ROWS, COLS } from "./config.js";
/** @typedef {import("../../types/model").SpecVersion} SpecVersion */
/** @typedef {import("../../types/model").RegionProgram} RegionProgram */
/** @typedef {import("../../types/model").Layout} Layout */
/** @typedef {import("../../types/model").RuleSet} RuleSet */
/** @typedef {import("../../types/model").AccuracyReport} AccuracyReport */

/** The built-in planner's region program: grid detected from the container's wall lines (mirrors spec_core.py). */
/** @type {RegionProgram} */
export const DEFAULT_PROGRAM = { program: "region-plan/v1", steps: [
  { op: "normalize_light" },
  { op: "grid_from_walls", rows: "auto", cols: "auto", inset: 6 },
  { op: "wall_segments", missing_below: WALL_MIN },
] };

/** The missing-wall threshold a program sets. @param {RegionProgram} p */
export const wallMinOf = (p) => {
  const st = p.steps.find((s) => s.op === "wall_segments");
  return st && st.op === "wall_segments" && st.missing_below !== undefined ? st.missing_below : WALL_MIN;
};

export const DEFAULT_SPEC_TEXT = "Each compartment holds exactly one pushpin.\nThe box holds 15 pushpins in total.\nEvery compartment is enclosed by walls.";

export const approved = {
  version: 0, approved_at: "",
  /** @type {RegionProgram} */ program: structuredClone(DEFAULT_PROGRAM),
  /** @type {Layout} */ layout: { rows: ROWS, cols: COLS },
  rules: createRuleSet(), threshold: 0.5, specText: DEFAULT_SPEC_TEXT,
  /** @type {AccuracyReport | null} */ accuracy: null,
};
/** @type {Set<() => void>} */ const listeners = new Set();
/** @param {() => void} f */ export const onApprovedChanged = (f) => { listeners.add(f); };

/** @param {SpecVersion} spec */
function apply(spec) {
  const set = createRuleSet([]);
  for (const r of spec.rules) { set.add(r.type, r.p); set.items[set.items.length - 1].on = r.on; }
  Object.assign(approved, { version: spec.version, approved_at: spec.approved_at,
                            program: spec.program || structuredClone(DEFAULT_PROGRAM),
                            layout: spec.layout || { rows: ROWS, cols: COLS },
                            rules: set, threshold: spec.threshold, accuracy: spec.accuracy,
                            specText: spec.spec_text || DEFAULT_SPEC_TEXT });
  listeners.forEach((f) => f());
}

/** Load the latest approved specification (keeps the default if none, or if the server can't be reached). */
export async function loadApproved() {
  try {
    const r = await fetch("api/spec", { cache: "no-store" });
    if (r.ok) { const { spec } = await r.json(); if (spec && spec.program) apply(spec); }
  } catch (_) { /* default spec */ }
  listeners.forEach((f) => f());
}

/**
 * Approve a draft: the server validates it, stores it as the next version, and the line switches to it.
 * @param {{ program: RegionProgram, layout: Layout | null, rules: RuleSet["items"], threshold: number, accuracy: AccuracyReport | null, specText: string }} draft
 * @param {string} token admin token ("" if the deployment doesn't require one)
 * @returns {Promise<SpecVersion>}
 */
export async function approve(draft, token) {
  const body = { program: draft.program, layout: draft.layout, rules: draft.rules.map((r) => ({ type: r.type, on: r.on, p: r.p })),
                 threshold: draft.threshold, accuracy: draft.accuracy, spec_text: draft.specText };
  const r = await fetch("api/spec", { method: "POST", headers: { "Content-Type": "application/json", "X-Admin-Token": token },
                                      body: JSON.stringify(body) });
  if (r.status === 403) throw Object.assign(new Error("admin token required"), { code: 403 });
  if (!r.ok) {
    const d = (await r.json().catch(() => ({}))).detail;
    throw new Error(Array.isArray(d) ? d.map((x) => x.msg).join("; ") : d || `HTTP ${r.status}`);
  }
  const { spec } = await r.json();
  apply(spec);
  return spec;
}

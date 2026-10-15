// @ts-check
// The rule library of the first prototype: typed rules (each_exact, box_exact, walls, ...). Rules are now expressions
// (see ruleset.js); these definitions remain for converting specifications approved before that change.
/** @typedef {import("../../types/model").Rule} Rule */
/** @typedef {import("../../types/model").RuleType} RuleType */
/** @typedef {import("../../types/model").RuleDef} RuleDef */
/** @typedef {import("../../types/model").RuleParams} RuleParams */
/** @typedef {import("../../types/model").RuleSet} RuleSet */
/** @typedef {import("../../types/model").RuleStatus} RuleStatus */
/** @typedef {import("../../types/model").Entry} Entry */
/** @typedef {import("../../types/model").Wall} Wall */
/** @typedef {import("../../types/model").Dist} Dist */
/** @typedef {import("../../types/model").EvalCell} EvalCell */
/** @typedef {import("../../types/model").Evaluation} Evaluation */

export const COLOURS = ["yellow", "orange", "red", "pink", "purple", "blue", "cyan", "green"];

// t: sentence template ({x} = editable field) · p: default parameters · k: which checker answers it
/** @type {Record<RuleType, RuleDef>} */
export const RULE_DEFS = {
  each_exact: { p: { n: 1 }, t: "Each compartment holds exactly {n} pin(s)" },
  each_max:   { p: { n: 1 }, t: "Each compartment holds at most {n} pin(s)" },
  each_min:   { p: { n: 1 }, t: "Each compartment holds at least {n} pin(s)" },
  cell_exact: { p: { r: 1, c: 1, n: 1 }, t: "Compartment row {r} col {c} holds exactly {n} pin(s)" },
  row_total:  { p: { r: 1, n: 5 }, t: "Row {r} holds exactly {n} pins in total" },
  col_total:  { p: { c: 1, n: 3 }, t: "Column {c} holds exactly {n} pins in total" },
  box_exact:  { p: { n: 15 }, t: "The box holds exactly {n} pins in total" },
  box_range:  { p: { a: 14, b: 16 }, t: "The box holds between {a} and {b} pins" },
  walls:      { p: {}, t: "Every compartment is enclosed by walls", k: "geometry" },
  color_all:  { p: { col: "yellow" }, t: "Every pushpin is {col}", k: "pixel colour" },
  color_same: { p: {}, t: "All pushpins are the same colour", k: "pixel colour" },
};

/** @param {RuleType[]} [types] @returns {RuleSet} */
export function createRuleSet(types = ["each_exact", "box_exact", "walls"]) {
  /** @type {RuleSet} */
  const set = {
    items: [], seq: 0,
    add(type, p) { set.items.push({ id: ++set.seq, type, on: true, p: { ...RULE_DEFS[type].p, ...(p || {}) } }); },
    remove(rule) { set.items = set.items.filter((x) => x !== rule); },
  };
  types.forEach((t) => set.add(t));
  return set;
}

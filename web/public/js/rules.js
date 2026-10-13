// @ts-check
// The written specification: rule types and their evaluation. Pure logic, no DOM, unit-tested in tests/.
import { WALL_MIN } from "./config.js";
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

/** @param {Dist} dist */
const argmax = (dist) => Object.entries(dist).sort((a, b) => b[1] - a[1])[0][0];
/** @param {Dist} dist @param {(k: number) => boolean} f */
const probWhere = (dist, f) => Object.entries(dist).reduce((a, [k, v]) => a + (f(parseInt(k, 10)) ? v : 0), 0);
/** @param {Wall} w */
const wallText = (w) => w.o === "v" ? `between row ${w.r + 1} col ${w.c + 1} and col ${w.c + 2}`
                                    : `between rows ${w.r + 1} and ${w.r + 2}, col ${w.c + 1}`;
/** @param {number | undefined} v */
const num = (v) => v ?? 0;

/**
 * Apply the rules to one analysed box.
 * @param {Pick<Entry, "cells" | "walls">} entry recorded or live analysis of the box (only its compartments and walls are used)
 * @param {(string | null)[] | null | undefined} colors pin colour per compartment, if measured
 * @param {Rule[]} rules the written specification, in order (R1, R2, ...)
 * @param {number} threshold flag a compartment when P(violation) exceeds this
 * @returns {Evaluation}
 */
export function evaluate(entry, colors, rules, threshold) {
  const hasModel = entry.cells.some((c) => c.dist);
  /** @type {EvalCell[]} */
  const cells = entry.cells.map((c) => ({ ...c, count: c.dist ? argmax(c.dist) : "–", viol: null, flagged: false }));
  /** @param {EvalCell} c */
  const count = (c) => (c.count === "–" ? 0 : parseInt(c.count, 10));
  /** @param {(c: EvalCell) => boolean} sel */
  const total = (sel) => cells.filter(sel).reduce((a, c) => a + count(c), 0);
  /** @type {string[]} */ const findings = [];
  /** @type {Record<number, RuleStatus>} */ const status = {};
  /** @type {Wall[]} */ const missingAll = [];

  rules.forEach((rule, i) => {
    const L = `R${i + 1}`, p = rule.p;
    if (!rule.on) { status[rule.id] = "off"; return; }

    if (rule.type === "walls") {
      const missing = entry.walls.filter((w) => w.strength < WALL_MIN);
      missingAll.push(...missing);
      missing.forEach((w) => findings.push(`${L}: wall ${wallText(w)} is <b>missing</b>`));
      status[rule.id] = missing.length ? "fail" : "pass";
      return;
    }

    if (rule.type === "color_all" || rule.type === "color_same") {
      if (!colors) { status[rule.id] = "n/a"; return; }
      const found = /** @type {string[]} */ (colors.filter(Boolean));
      /** @type {Record<string, number>} */
      const tally = found.reduce((a, c) => ((a[c] = (a[c] || 0) + 1), a), /** @type {Record<string, number>} */ ({}));
      const target = rule.type === "color_all" ? p.col : Object.entries(tally).sort((a, b) => b[1] - a[1])[0]?.[0];
      let fail = false;
      if (rule.type === "color_same" && new Set(found).size > 1)
        findings.push(`${L}: mixed colours in one box (${[...new Set(found)].join(", ")})`);
      cells.forEach((c, k) => {
        if (colors[k] && target && colors[k] !== target) {
          c.flagged = true; fail = true;
          if (rule.type === "color_all")
            findings.push(`${L}: compartment row ${c.r + 1}, col ${c.c + 1} has a <b>${colors[k]}</b> pin, expected ${target}`);
        }
      });
      status[rule.id] = fail ? "fail" : "pass";
      return;
    }

    if (!hasModel) { status[rule.id] = "n/a"; return; }
    let fail = false;
    /** @param {EvalCell} c @param {number} viol @param {string} what */
    const cellRule = (c, viol, what) => {
      if (viol > threshold) {
        c.flagged = true; c.viol = Math.max(c.viol || 0, viol); fail = true;
        findings.push(`${L}: compartment row ${c.r + 1}, col ${c.c + 1} looks like <b>${c.count}</b> pin(s), ${what} (P = ${viol.toFixed(2)})`);
      }
    };
    /** @param {number} t @param {boolean} ok @param {string} what */
    const totalRule = (t, ok, what) => { if (!ok) { fail = true; findings.push(`${L}: ${what.replace("{t}", `<b>${t}</b>`)}`); } };
    /** @param {EvalCell} c @param {number} n probability that the compartment does not hold exactly n */
    const notExactly = (c, n) => 1 - ((c.dist || {})[String(n)] || 0);
    const n = num(p.n);
    switch (rule.type) {
      case "each_exact": cells.forEach((c) => cellRule(c, notExactly(c, n), `expected ${n}`)); break;
      case "each_max":   cells.forEach((c) => cellRule(c, probWhere(c.dist || {}, (k) => k > n), `at most ${n} allowed`)); break;
      case "each_min":   cells.forEach((c) => cellRule(c, probWhere(c.dist || {}, (k) => k < n), `at least ${n} required`)); break;
      case "cell_exact": cells.filter((c) => c.r === num(p.r) - 1 && c.c === num(p.c) - 1)
                              .forEach((c) => cellRule(c, notExactly(c, n), `expected ${n}`)); break;
      case "row_total": { const t = total((c) => c.r === num(p.r) - 1); totalRule(t, t === n, `row ${p.r} holds {t} pins, expected ${n}`); break; }
      case "col_total": { const t = total((c) => c.c === num(p.c) - 1); totalRule(t, t === n, `column ${p.c} holds {t} pins, expected ${n}`); break; }
      case "box_exact": { const t = total(() => true); totalRule(t, t === n, `the box holds {t} pins, expected ${n}`); break; }
      case "box_range": { const t = total(() => true); totalRule(t, t >= num(p.a) && t <= num(p.b), `the box holds {t} pins, expected ${p.a}-${p.b}`); break; }
    }
    status[rule.id] = fail ? "fail" : "pass";
  });

  return { cells, missing: missingAll, failed: findings.length > 0, findings, hasModel, status };
}

// @ts-check
// Rule sets (format "rules/v2"): what each region and each box must satisfy, as expression rules (see expr.js),
// with named parameters (some adjustable by the operator) and custom questions the planner asks Gemma per region.
// The production line, live inspections, the Admin page and the accuracy report all evaluate rule sets here.
import { WALL_MIN } from "./config.js";
import { parse, parseSelector, selects, validate, probability, evalBox, idents } from "./expr.js";
import { COLOURS, RULE_DEFS } from "./rules.js";
/** @typedef {import("../../types/model").RuleSetV2} RuleSetV2 */
/** @typedef {import("../../types/model").ExprRule} ExprRule */
/** @typedef {import("../../types/model").Entry} Entry */
/** @typedef {import("../../types/model").Wall} Wall */
/** @typedef {import("../../types/model").EvalCell} EvalCell */
/** @typedef {import("../../types/model").Evaluation} Evaluation */
/** @typedef {import("../../types/model").Rule} Rule */
/** @typedef {import("../../types/model").RuleStatus} RuleStatus */

const ID = /^[A-Za-z][A-Za-z0-9_]{0,23}$/;

/**
 * Validate a rule set (object or JSON text). Throws an Error with a readable message; returns a clean copy.
 * @param {string | object} input @returns {RuleSetV2}
 */
export function parseRuleSet(input) {
  /** @type {any} */ let d = input;
  if (typeof input === "string") { try { d = JSON.parse(input); } catch (e) { throw new Error(`not valid JSON: ${e instanceof Error ? e.message : e}`); } }
  if (!d || typeof d !== "object") throw new Error("expected a rule-set object");
  if (d.version !== undefined && d.version !== "rules/v2") throw new Error(`unsupported rule-set version "${d.version}"`);
  const sensitivity = d.sensitivity ?? 0.5;
  if (typeof sensitivity !== "number" || sensitivity < 0.05 || sensitivity > 0.95) throw new Error(`"sensitivity" must be a number from 0.05 to 0.95`);
  /** @type {RuleSetV2["params"]} */ const params = {};
  for (const [name, p] of Object.entries(d.params ?? {})) {
    if (!ID.test(name)) throw new Error(`parameter name "${name}" must be a short identifier`);
    const pp = /** @type {any} */ (p);
    const kind = pp?.kind ?? (typeof pp?.default === "string" ? "colour" : "count");
    if (kind === "colour") { if (pp.default !== "any" && !COLOURS.includes(pp.default)) throw new Error(`parameter "${name}": colour must be "any" or one of ${COLOURS.join(", ")}`); }
    else if (kind === "count") { if (!Number.isInteger(pp.default) || pp.default < 0 || pp.default > 99) throw new Error(`parameter "${name}": default must be a whole number from 0 to 99`); }
    else throw new Error(`parameter "${name}": kind must be "count" or "colour"`);
    params[name] = { default: pp.default, kind, ...(pp.operator ? { operator: true } : {}), ...(pp.label ? { label: String(pp.label).slice(0, 60) } : {}) };
  }
  /** @type {RuleSetV2["questions"]} */ const questions = [];
  for (const q of d.questions ?? []) {
    if (!q || !ID.test(q.id)) throw new Error(`question id "${q && q.id}" must be a short identifier`);
    if (typeof q.text !== "string" || q.text.length < 5 || q.text.length > 200) throw new Error(`question "${q.id}": text must be 5-200 characters`);
    if (!["yesno", "count"].includes(q.answer)) throw new Error(`question "${q.id}": answer must be "yesno" or "count"`);
    questions.push({ id: q.id, text: q.text, answer: q.answer });
  }
  if (questions.length > 4) throw new Error("at most 4 custom questions (each one is asked in every region)");
  if (!Array.isArray(d.rules) || d.rules.length < 1 || d.rules.length > 20) throw new Error(`expected 1-20 "rules"`);
  const ctx = { params: Object.keys(params), questions: Object.fromEntries(questions.map((q) => [q.id, q.answer])) };
  /** @type {ExprRule[]} */ const rules = [];
  const seen = new Set();
  d.rules.forEach((/** @type {any} */ r, /** @type {number} */ i) => {
    const id = r?.id ?? `R${i + 1}`, where = `rule ${id}`;
    if (!ID.test(id) || seen.has(id)) throw new Error(`${where}: id must be a unique short identifier`);
    seen.add(id);
    if (r.for !== undefined) parseSelector(r.for);
    let tree;
    try { tree = parse(r.test); validate(tree, r.for !== undefined ? "region" : "box", ctx); }
    catch (e) { throw new Error(`${where}: ${e instanceof Error ? e.message : e}`); }
    rules.push({ id, test: String(r.test), ...(r.for !== undefined ? { for: String(r.for) } : {}),
                 ...(r.text ? { text: String(r.text).slice(0, 200) } : {}), ...(r.on === false ? { on: false } : {}) });
  });
  return { version: "rules/v2", sensitivity, params, questions, rules };
}

/** @param {RuleSetV2} rs */
export const ruleSetToJson = (rs) => JSON.stringify(rs, null, 2);

/** Which checker answers a rule, from what it reads. @param {ExprRule} r */
export function checkerOf(r) {
  const ids = idents(parse(r.test));
  const kinds = [];
  if ([...ids].some((v) => v.startsWith("q."))) kinds.push("Gemma question");
  if (ids.has("count")) kinds.push(r.for !== undefined ? "Gemma" : "Gemma · sum");
  if (ids.has("colour")) kinds.push("pixel colour");
  if (ids.has("walls.missing")) kinds.push("geometry");
  return kinds.join(" + ") || "constant";
}

/** A rule in words: the planner's sentence, or the expression. @param {ExprRule} r */
export const ruleText = (r) => r.text || `${r.for !== undefined ? `in ${r.for}: ` : ""}${r.test}`;

/** Current parameter values: defaults, overridden by operator settings. @param {RuleSetV2} rs @param {Record<string, number | string>} [overrides] */
export function paramValues(rs, overrides = {}) {
  return Object.fromEntries(Object.entries(rs.params).map(([k, p]) => [k, p.operator && overrides[k] !== undefined ? overrides[k] : p.default]));
}

// ---------------- conversion from the old typed rules (approved specs from before rules/v2) ----------------
/** @param {Rule[]} items @param {number} threshold @returns {RuleSetV2} */
export function typedToRuleSet(items, threshold = 0.5) {
  /** @type {RuleSetV2} */ const rs = { version: "rules/v2", sensitivity: threshold, params: {}, questions: [], rules: [] };
  items.forEach((r, i) => {
    const id = `R${i + 1}`, p = r.p, op = (/** @type {string} */ k) => !!r.operator?.includes(/** @type {any} */ (k));
    /** @param {string} k @param {"count" | "colour"} kind */
    const param = (k, kind) => { const name = k === "col" ? "colour" : `${k}_${id}`; rs.params[name] = { default: /** @type {any} */ (p)[k], kind, ...(op(k) ? { operator: true } : {}) }; return `param.${name}`; };
    const n = op("n") ? param("n", "count") : String(p.n);
    const text = RULE_DEFS[r.type].t.replace(/\{(\w+)\}/g, (_, k) => String(/** @type {any} */ (p)[k] ?? ""));
    /** @type {{ for?: string, test: string }} */ let x;
    switch (r.type) {
      case "each_exact": x = { for: "all", test: `count == ${n}` }; break;
      case "each_max": x = { for: "all", test: `count <= ${n}` }; break;
      case "each_min": x = { for: "all", test: `count >= ${n}` }; break;
      case "cell_exact": x = { for: `cell ${p.r} ${p.c}`, test: `count == ${n}` }; break;
      case "row_total": x = { test: `total(count, "row ${p.r}") == ${n}` }; break;
      case "col_total": x = { test: `total(count, "col ${p.c}") == ${n}` }; break;
      case "box_exact": x = { test: `total(count) == ${n}` }; break;
      case "box_range": x = { test: `total(count) >= ${p.a} and total(count) <= ${p.b}` }; break;
      case "walls": x = { test: "walls.missing == 0" }; break;
      case "color_all": x = { for: "all", test: `colour == ${op("col") ? param("col", "colour") : `"${p.col}"`}` }; break;
      default: x = { test: "distinct(colour) <= 1" };
    }
    rs.rules.push({ id, text, ...x, ...(r.on ? {} : { on: false }) });
  });
  return rs;
}

// ---------------- evaluation ----------------
/** @param {Wall} w */
const wallText = (w) => w.o === "v" ? `between row ${w.r + 1} col ${w.c + 1} and col ${w.c + 2}`
                                    : `between rows ${w.r + 1} and ${w.r + 2}, col ${w.c + 1}`;
/** @param {Record<string, number>} d */
const argmax = (d) => Object.entries(d).sort((a, b) => b[1] - a[1])[0][0];
const where = (/** @type {{ r: number, c: number, id?: string }} */ c) => c.id ? `region ${c.id}` : `compartment row ${c.r + 1}, col ${c.c + 1}`;

/**
 * Apply a rule set to one analysed box.
 * @param {Pick<Entry, "cells" | "walls">} entry recorded or live analysis (cells may carry q: answers to custom questions)
 * @param {(string | null)[] | null | undefined} colors pin colour per region, if measured
 * @param {RuleSetV2} rs @param {number} threshold flag a region when P(violation) exceeds this
 * @param {number} [wallMin] wall-line strength below which a wall is missing
 * @param {Record<string, number | string>} [overrides] operator settings
 * @returns {Evaluation}
 */
export function evaluateRuleSet(entry, colors, rs, threshold, wallMin = WALL_MIN, overrides = {}) {
  const values = paramValues(rs, overrides);
  const fixedParams = Object.fromEntries(Object.entries(values).map(([k, v]) => [`param.${k}`, v]));
  const hasModel = entry.cells.some((c) => c.dist);
  /** @type {EvalCell[]} */
  const cells = entry.cells.map((c) => ({ ...c, count: c.dist ? argmax(c.dist) : "–", viol: null, flagged: false }));
  const missingWalls = entry.walls.filter((w) => w.strength < wallMin);
  const dists = (/** @type {any} */ c) => ({ count: c.dist ?? null, ...Object.fromEntries(rs.questions.map((q) => [`q.${q.id}`, c.q?.[q.id] ?? null])) });
  /** @type {string[]} */ const findings = [];
  /** @type {Record<string, RuleStatus>} */ const status = {};
  /** @type {Wall[]} */ let missing = [];

  for (const rule of rs.rules) {
    if (rule.on === false) { status[rule.id] = "off"; continue; }
    const tree = parse(rule.test), label = rule.text ? `"${rule.text}"` : rule.test;
    if (rule.for !== undefined) {
      const sel = parseSelector(rule.for);
      let judged = 0, fail = false;
      /** @type {string[]} */ const ruleFindings = [];
      cells.forEach((c, k) => {
        if (!selects(sel, c)) return;
        const colour = colors ? (colors[k] ?? null) : null;
        if (idents(tree).has("colour") && !colour) return;            // no pin colour here: nothing to judge
        const p = probability(tree, dists(c), { ...fixedParams, colour });
        if (p === null) return;
        judged++;
        const viol = 1 - p;
        if (viol > threshold) {
          c.flagged = true; c.viol = Math.max(c.viol || 0, viol); fail = true;
          const seen = idents(tree).has("colour") && colour ? `has a <b>${colour}</b> pin` : c.dist ? `looks like <b>${c.count}</b> pin(s)` : "fails";
          ruleFindings.push(`${where(c)} ${seen} (P = ${viol.toFixed(2)})`);
        }
      });
      if (ruleFindings.length > 3)                                   // one line per rule when many regions fail it
        findings.push(`${rule.id}: ${label} fails in <b>${ruleFindings.length}</b> regions: ${ruleFindings.slice(0, 2).join("; ")}; +${ruleFindings.length - 2} more`);
      else ruleFindings.forEach((f) => findings.push(`${rule.id}: ${f}, rule ${label}`));
      status[rule.id] = !judged ? "n/a" : fail ? "fail" : "pass";
    } else {
      const { ok, used } = evalBox(tree, {
        cells: cells.map((c, k) => ({ r: c.r, c: c.c, id: /** @type {any} */ (c).id, dists: dists(c), colour: colors ? (colors[k] ?? null) : undefined })),
        wallsMissing: missingWalls.length, params: values,
      });
      if (ok === null) { status[rule.id] = "n/a"; continue; }
      if (ok) { status[rule.id] = "pass"; continue; }
      status[rule.id] = "fail";
      if ("walls.missing" in used && missingWalls.length) {
        missing = missingWalls;
        missingWalls.forEach((w) => findings.push(`${rule.id}: wall ${wallText(w)} is <b>missing</b>`));
      }
      const vals = Object.entries(used).filter(([k]) => k !== "walls.missing").map(([k, v]) => `${k} = <b>${v}</b>`);
      if (vals.length || !("walls.missing" in used)) findings.push(`${rule.id}: ${label} not met${vals.length ? ` (${vals.join(", ")})` : ""}`);
    }
  }
  return { cells, missing, failed: findings.length > 0, findings, hasModel, status };
}

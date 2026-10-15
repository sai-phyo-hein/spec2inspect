// Unit tests for the rule engine: the original typed rules, converted to expression rules (rules/v2) and evaluated by
// the rule-set engine, must behave exactly as before. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRuleSet } from "../public/js/rules.js";
import { typedToRuleSet, evaluateRuleSet } from "../public/js/ruleset.js";

/** The old call shape, on the new engine. @param {any} entry @param {any} colors @param {any[]} items @param {number} thr */
const evaluate = (entry, colors, items, thr) => evaluateRuleSet(entry, colors, typedToRuleSet(items, thr), thr, 0.3);

// @ts-check
/** @typedef {import("../types/model").Entry} Entry */

/** A confident answer of n pins. @param {number} n */
const sure = (n) => Object.fromEntries([...Array(10).keys()].map((k) => [String(k), k === n ? 0.98 : 0.02 / 9]));

/**
 * A 3 x 5 box with the given pin counts and one measured wall.
 * @param {{ counts?: number[], wallStrength?: number, label?: 0 | 1 }} [opts]
 * @returns {Pick<Entry, "cells" | "walls" | "label">}
 */
function box({ counts = Array(15).fill(1), wallStrength = 0.9, label = 0 } = {}) {
  return {
    label,
    cells: counts.map((n, i) => ({ r: Math.floor(i / 5), c: i % 5, box: [0, 0, 1, 1], dist: sure(n) })),
    walls: [{ o: "v", r: 1, c: 1, strength: wallStrength }, { o: "h", r: 0, c: 0, strength: 0.9 }],
  };
}
const defaults = () => createRuleSet().items;           // each_exact 1, box_exact 15, walls

test("a good box passes the default rules", () => {
  const res = evaluate(box(), null, defaults(), 0.5);
  assert.equal(res.failed, false);
  assert.deepEqual(res.findings, []);
});

test("an empty compartment breaks 'exactly 1' and the box total", () => {
  const counts = Array(15).fill(1); counts[7] = 0;
  const res = evaluate(box({ counts }), null, defaults(), 0.5);
  assert.equal(res.failed, true);
  assert.ok(res.findings.some((f) => f.startsWith("R1: compartment row 2, col 3")));
  assert.ok(res.findings.some((f) => f.startsWith("R2:") && f.includes("total(count) = <b>14</b>")));
  assert.equal(res.cells[7].flagged, true);
});

test("a missing wall is caught by the geometry rule", () => {
  const res = evaluate(box({ wallStrength: 0.06 }), null, defaults(), 0.5);
  assert.equal(res.failed, true);
  assert.equal(res.missing.length, 1);
  assert.match(res.findings[0], /^R3: wall between row 2 col 2 and col 3/);
});

test("a rule switched off is ignored", () => {
  const rules = defaults(); rules[2].on = false;
  const res = evaluate(box({ wallStrength: 0.06 }), null, rules, 0.5);
  assert.equal(res.failed, false);
  assert.equal(res.status.R3, "off");
});

test("changing the spec to 2 pins per compartment rejects a 1-pin box", () => {
  const set = createRuleSet(["each_exact"]); set.items[0].p.n = 2;
  const res = evaluate(box(), null, set.items, 0.5);
  assert.equal(res.failed, true);
  assert.equal(res.cells.filter((c) => c.flagged).length, 15);
});

test("the sensitivity threshold decides borderline compartments", () => {
  const b = box(); b.cells[0].dist = { "0": 0.4, "1": 0.6 };
  const rules = createRuleSet(["each_exact"]).items;
  assert.equal(evaluate(b, null, rules, 0.5).failed, false);   // P(violation) = 0.4
  assert.equal(evaluate(b, null, rules, 0.3).failed, true);
});

test("colour rules use the measured pin colours", () => {
  const colors = Array(15).fill("yellow"); colors[4] = "blue";
  const yellowOnly = createRuleSet(["color_all"]).items;
  const sameColour = createRuleSet(["color_same"]).items;
  assert.match(evaluate(box(), colors, yellowOnly, 0.5).findings[0], /row 1, col 5 has a <b>blue<\/b> pin/);
  assert.match(evaluate(box(), colors, sameColour, 0.5).findings[0], /distinct\(colour\) = <b>2<\/b>/);
  assert.equal(evaluate(box(), Array(15).fill("yellow"), yellowOnly, 0.5).failed, false);
});

test("row, column and range totals", () => {
  const counts = Array(15).fill(1); counts[0] = 2;
  const set = createRuleSet(["row_total", "col_total", "box_range"]);
  const res = evaluate(box({ counts }), null, set.items, 0.5);
  assert.ok(res.findings.some((f) => f.startsWith("R1:") && f.includes('total(count, "row 1") = <b>6</b>')));
  assert.ok(res.findings.some((f) => f.startsWith("R2:") && f.includes('total(count, "col 1") = <b>4</b>')));
  assert.equal(res.status.R3, "pass");                         // 16 is within 14-16
});



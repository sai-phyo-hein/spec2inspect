// Unit tests for the accuracy report used by the Admin rule builder. Run: npm test
// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { auroc, measureAccuracy } from "../public/js/accuracy.js";
import { createRuleSet } from "../public/js/rules.js";

const sure = (/** @type {number} */ n) => Object.fromEntries([...Array(10).keys()].map((k) => [String(k), k === n ? 0.98 : 0.02 / 9]));
/** @param {number[]} counts @param {0|1} label @param {number} [wall] */
const entry = (counts, label, wall = 0.9) => ({
  entry: "e", img_id: "i", label, color: "Original", stops: 0, rows: 3, cols: 5, xs: [0, 1, 2, 3, 4, 5], ys: [0, 1, 2, 3], grid_strength: 1,
  cells: counts.map((n, i) => ({ r: Math.floor(i / 5), c: i % 5, box: /** @type {[number, number, number, number]} */ ([0, 0, 1, 1]), dist: sure(n) })),
  walls: [{ o: /** @type {"v"} */ ("v"), r: 1, c: 1, strength: wall }],
});
const ones = Array(15).fill(1), empty = [0, ...Array(14).fill(1)];

test("auroc: perfect, chance and undefined cases", () => {
  assert.equal(auroc([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1]), 1);
  assert.equal(auroc([0.5, 0.5, 0.5, 0.5], [0, 1, 0, 1]), 0.5);
  assert.equal(auroc([0.1, 0.2], [0, 0]), null);
});

test("measureAccuracy counts the confusion matrix against the labels", () => {
  const entries = [entry(ones, 0), entry(ones, 0), entry(empty, 1), entry(ones, 1, 0.05), entry(ones, 1)];  // last anomaly is missed
  const rep = measureAccuracy(entries, createRuleSet().items, 0.5, 0.3);
  assert.deepEqual([rep.tp, rep.fn, rep.fp, rep.tn], [2, 1, 0, 2]);
  assert.equal(rep.n, 5);
  assert.equal(rep.accuracy, 0.8);
  assert.ok(rep.auroc !== null && rep.auroc > 0.5);
});

test("a stricter wall threshold changes the result", () => {
  const entries = [entry(ones, 0, 0.4), entry(ones, 1, 0.05)];
  assert.equal(measureAccuracy(entries, createRuleSet(["walls"]).items, 0.5, 0.3).accuracy, 1);
  assert.equal(measureAccuracy(entries, createRuleSet(["walls"]).items, 0.5, 0.5).fp, 1);   // the good box's wall now "missing"
});

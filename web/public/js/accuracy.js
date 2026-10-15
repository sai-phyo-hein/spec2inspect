// @ts-check
// Accuracy of a draft rule set on the recorded, labelled test images (pure logic, unit-tested).
import { evaluate } from "./rules.js";
/** @typedef {import("../../types/model").Entry} Entry */
/** @typedef {import("../../types/model").Rule} Rule */
/** @typedef {import("../../types/model").AccuracyReport} AccuracyReport */

/** AUROC from scores and 0/1 labels (rank-based, ties averaged). @param {number[]} scores @param {number[]} labels */
export function auroc(scores, labels) {
  const pos = labels.filter((l) => l === 1).length, neg = labels.length - pos;
  if (!pos || !neg) return null;
  const order = scores.map((s, i) => [s, i]).sort((a, b) => a[0] - b[0]);
  /** @type {number[]} */ const rank = new Array(scores.length);
  for (let i = 0; i < order.length;) {
    let j = i; while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    for (let k = i; k <= j; k++) rank[order[k][1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  const sumPos = labels.reduce((a, l, i) => a + (l === 1 ? rank[i] : 0), 0);
  return (sumPos - pos * (pos + 1) / 2) / (pos * neg);
}

/**
 * Run the rules on every labelled entry and compare with the ground truth.
 * Score for AUROC: 1 for a rejected box, otherwise its largest compartment violation probability.
 * @param {Entry[]} entries @param {Rule[]} rules @param {number} threshold @param {number} wallMin
 * @returns {AccuracyReport}
 */
export function measureAccuracy(entries, rules, threshold, wallMin) {
  const labelled = entries.filter((e) => e.label === 0 || e.label === 1);
  let tp = 0, fp = 0, tn = 0, fn = 0;
  /** @type {number[]} */ const scores = [];
  /** @type {number[]} */ const labels = [];
  for (const e of labelled) {
    const res = evaluate(e, null, rules, threshold, wallMin);
    const maxViol = Math.max(0, ...res.cells.map((c) => (c.dist ? 1 - Math.max(...Object.values(c.dist)) : 0)));
    scores.push(res.failed ? 1 + maxViol : maxViol);
    labels.push(/** @type {number} */ (e.label));
    if (res.failed && e.label === 1) tp++; else if (res.failed) fp++; else if (e.label === 1) fn++; else tn++;
  }
  const n = labelled.length, a = auroc(scores, labels);
  return {
    images: `${n} recorded test images`, n, tp, fp, tn, fn,
    accuracy: n ? (tp + tn) / n : 0, recall: tp + fn ? tp / (tp + fn) : 0, false_alarm: fp + tn ? fp / (fp + tn) : 0,
    auroc: a, note: rules.some((r) => r.on && r.type.startsWith("color")) ? "colour rules are not measured on the recorded set" : undefined,
  };
}

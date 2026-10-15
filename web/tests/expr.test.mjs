// Unit tests for the rule expression language and rule sets. Run: npm test
// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, probability, evalBox, validate } from "../public/js/expr.js";
import { parseRuleSet, evaluateRuleSet, typedToRuleSet } from "../public/js/ruleset.js";
import { createRuleSet } from "../public/js/rules.js";

const sure = (/** @type {number} */ n) => Object.fromEntries([...Array(10).keys()].map((k) => [String(k), k === n ? 0.98 : 0.02 / 9]));
/** @param {number[]} counts @param {number} [wall] @param {any[]} [q] */
const box = (counts, wall = 0.9, q) => ({
  cells: counts.map((n, i) => ({ r: Math.floor(i / 5), c: i % 5, box: /** @type {[number, number, number, number]} */ ([0, 0, 1, 1]), dist: sure(n), ...(q ? { q: q[i] } : {}) })),
  walls: [{ o: /** @type {"v"} */ ("v"), r: 1, c: 1, strength: wall }],
});
const ones = Array(15).fill(1);

test("parser: precedence, functions, and readable errors", () => {
  assert.deepEqual(parse("not count == 1 or count > 2").t, "bin");
  assert.throws(() => parse("count === 1"), /unexpected/);
  assert.throws(() => parse("eval(count)"), /unknown function "eval"/);
  assert.throws(() => parse('colour == "red'), /unclosed string/);
});

test("validation: scope and names", () => {
  const ctx = { params: ["n"], questions: { chip: /** @type {"yesno"} */ ("yesno") } };
  validate(parse("count == param.n and q.chip == true"), "region", ctx);
  validate(parse('total(count, "row 1") == 5 and distinct(colour) <= 1'), "box", ctx);
  assert.throws(() => validate(parse("count == 1"), "box", ctx), /per-region measurement/);
  assert.throws(() => validate(parse("total(count) == 15"), "region", ctx), /box function/);
  assert.throws(() => validate(parse("count == param.m"), "region", ctx), /unknown parameter "param.m"/);
  assert.throws(() => validate(parse("weight > 3"), "region", ctx), /unknown name "weight"/);
  assert.throws(() => validate(parse('total(count, "diagonal") == 3'), "box", ctx), /unknown selector/);
});

test("probability enumerates Gemma's answer distribution", () => {
  const d = { "0": 0.1, "1": 0.7, "2": 0.2 };
  assert.ok(Math.abs(/** @type {number} */ (probability(parse("count == 1"), { count: d }, {})) - 0.7) < 1e-9);
  assert.ok(Math.abs(/** @type {number} */ (probability(parse("count >= 1 and count <= 2"), { count: d }, {})) - 0.9) < 1e-9);
  assert.equal(probability(parse("count == 1"), { count: null }, {}), null);
});

test("box functions use the most likely answers", () => {
  const b = box(ones);
  const cells = b.cells.map((c) => ({ ...c, dists: { count: c.dist }, colour: c.c === 0 ? "red" : "yellow" }));
  assert.equal(evalBox(parse("total(count) == 15"), { cells, wallsMissing: 0, params: {} }).ok, true);
  assert.equal(evalBox(parse('total(count, "row 2") == 5'), { cells, wallsMissing: 0, params: {} }).ok, true);
  assert.equal(evalBox(parse("distinct(colour)"), { cells, wallsMissing: 0, params: {} }).ok, 2);
});

test("converted typed rules give the same verdicts as before", () => {
  const rs = typedToRuleSet(createRuleSet().items, 0.5);
  assert.equal(evaluateRuleSet(box(ones), null, rs, 0.5, 0.3).failed, false);
  const empty = evaluateRuleSet(box([0, ...ones.slice(1)]), null, rs, 0.5, 0.3);
  assert.ok(empty.failed && empty.cells[0].flagged);
  const wall = evaluateRuleSet(box(ones, 0.05), null, rs, 0.5, 0.3);
  assert.ok(wall.failed && wall.missing.length === 1);
});

test("operator parameters, custom questions and n/a when a measurement is missing", () => {
  const rs = parseRuleSet({
    params: { n: { default: 1, kind: "count", operator: true }, colour: { default: "yellow", kind: "colour", operator: true } },
    questions: [{ id: "chip", text: "Is there a chip in this compartment?", answer: "yesno" }],
    rules: [{ id: "R1", for: "all", test: "count == param.n" }, { id: "R2", for: "all", test: "colour == param.colour" },
            { id: "R3", for: "all", test: "q.chip == false" }],
  });
  const twos = Array(15).fill(2), b = box(twos);
  assert.equal(evaluateRuleSet(b, null, rs, 0.5, 0.3).status.R1, "fail");
  assert.equal(evaluateRuleSet(b, null, rs, 0.5, 0.3, { n: 2 }).status.R1, "pass");                // operator setting
  const blue = Array(15).fill("blue");
  assert.equal(evaluateRuleSet(b, blue, rs, 0.5, 0.3, { n: 2 }).status.R2, "fail");
  assert.equal(evaluateRuleSet(b, blue, rs, 0.5, 0.3, { n: 2, colour: "blue" }).status.R2, "pass");
  assert.equal(evaluateRuleSet(b, blue, rs, 0.5, 0.3).status.R3, "n/a");                           // recorded: no answers
  const chips = Array(15).fill({ chip: { yes: 0.9, no: 0.1 } });
  assert.equal(evaluateRuleSet(box(twos, 0.9, chips), null, rs, 0.5, 0.3).status.R3, "fail");
});

test("rule-set validation messages", () => {
  const bad = (/** @type {object} */ d) => { try { parseRuleSet(d); return ""; } catch (e) { return String(e instanceof Error ? e.message : e); } };
  assert.match(bad({ rules: [] }), /1-20 "rules"/);
  assert.match(bad({ rules: [{ id: "R1", for: "row 9x", test: "count == 1" }] }), /unknown selector/);
  assert.match(bad({ rules: [{ id: "R1", test: "count == 1" }] }), /rule R1: "count" is a per-region measurement/);
  assert.match(bad({ params: { c: { default: "teal", kind: "colour" } }, rules: [{ test: "walls.missing == 0" }] }), /colour must be "any" or one of/);
  assert.match(bad({ questions: [{ id: "x", text: "short", answer: "maybe" }], rules: [{ test: "walls.missing == 0" }] }), /yesno/);
});

test('"any" colour is not enforced, and repeated region failures become one finding', () => {
  const rs = parseRuleSet({ params: { detecting_color: { default: "yellow", kind: "colour", operator: true } },
                            rules: [{ id: "R4", for: "all", test: "colour == param.detecting_color", text: "Every pushpin has the selected colour" }] });
  const blue = Array(15).fill("blue"), b = box(ones);
  const strict = evaluateRuleSet(b, blue, rs, 0.5, 0.3);
  assert.equal(strict.status.R4, "fail");
  assert.equal(strict.findings.length, 1);                                    // not 15 lines
  assert.match(strict.findings[0], /fails in <b>15<\/b> regions/);
  assert.equal(evaluateRuleSet(b, blue, rs, 0.5, 0.3, { detecting_color: "any" }).status.R4, "pass");
  assert.equal(parseRuleSet({ params: { c: { default: "any", kind: "colour", operator: true } },
                              rules: [{ for: "all", test: "colour == param.c" }] }).params.c.default, "any");
});

test("colour rules are unknown (not failed) when pin colours weren't measured", () => {
  const rs = parseRuleSet({ rules: [{ id: "R1", test: "distinct(colour) > 1" }] });
  assert.equal(evaluateRuleSet(box(ones), null, rs, 0.5, 0.3).status.R1, "n/a");                    // recordings: no colours
  assert.equal(evaluateRuleSet(box(ones), Array(15).fill("yellow"), rs, 0.5, 0.3).status.R1, "fail");
  const mixed = Array(15).fill("yellow"); mixed[3] = "blue";
  assert.equal(evaluateRuleSet(box(ones), mixed, rs, 0.5, 0.3).status.R1, "pass");
});

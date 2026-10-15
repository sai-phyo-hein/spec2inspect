// @ts-check
// The rule expression language. Rules are written (by the planner, or by hand) as small expressions over region
// measurements, parsed and validated before they run, and evaluated here. Pure logic, no DOM; unit-tested.
//
//   per-region rule:  { "for": "all", "test": "count == param.n" }          checked in every selected region
//   box rule:         { "test": "total(count) == 15 and walls.missing == 0" } checked once per box
//
// Measurements in a region: count (Gemma: pins in the region, 0-9), colour (pixels: dominant pin hue, or none),
//   q.<id> (Gemma: a custom question from the rule set; yes/no or a count).
// Box functions: total(m[, "selector"]) sums a count-like measurement; distinct(colour[, "selector"]) counts colours;
//   walls.missing is the number of missing walls.
// Selectors: "all", "row 2", "col 3", "cell 2 3" (rows and columns count from 1), "region left" (a named region).
// Operators: == != < <= > >=  + -  and or not  ( ). Values: numbers, "strings", true, false, param.<name>.
// The colour value "any" matches every colour, so a colour rule whose operator setting is "any" is not enforced.

/** @typedef {{ t: "num", v: number } | { t: "str", v: string } | { t: "bool", v: boolean } | { t: "id", v: string }
 *   | { t: "call", fn: string, args: Node[] } | { t: "not", a: Node } | { t: "bin", op: string, a: Node, b: Node }} Node */
/** @typedef {{ kind: "all" } | { kind: "row", r: number } | { kind: "col", c: number } | { kind: "cell", r: number, c: number } | { kind: "region", id: string }} Selector */

export const FUNCTIONS = ["total", "distinct"];
const CMP = ["==", "!=", "<", "<=", ">", ">="];

/** @param {string} msg @param {string} src @param {number} pos */
const fail = (msg, src, pos) => { throw new Error(`${msg} at "${src.slice(Math.max(0, pos - 6), pos + 8)}"`); };

/** @param {string} src @returns {{ k: string, v: string, p: number }[]} */
function tokenize(src) {
  /** @type {{ k: string, v: string, p: number }[]} */ const out = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    const two = src.slice(i, i + 2);
    if (["==", "!=", "<=", ">="].includes(two)) { out.push({ k: "op", v: two, p: i }); i += 2; continue; }
    if ("<>+-(),".includes(ch)) { out.push({ k: "op", v: ch, p: i }); i++; continue; }
    if (ch === '"' || ch === "'") {
      const j = src.indexOf(ch, i + 1); if (j < 0) fail("unclosed string", src, i);
      out.push({ k: "str", v: src.slice(i + 1, j), p: i }); i = j + 1; continue;
    }
    const num = /^\d+(\.\d+)?/.exec(src.slice(i));
    if (num) { out.push({ k: "num", v: num[0], p: i }); i += num[0].length; continue; }
    const id = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?/.exec(src.slice(i));
    if (id) { out.push({ k: "id", v: id[0], p: i }); i += id[0].length; continue; }
    fail(`unexpected "${ch}"`, src, i);
  }
  return out;
}

/** Parse an expression into a tree. @param {string} src @returns {Node} */
export function parse(src) {
  if (typeof src !== "string" || !src.trim()) throw new Error("empty expression");
  if (src.length > 300) throw new Error("expression longer than 300 characters");
  const tk = tokenize(src); let i = 0;
  const peek = () => tk[i], next = () => tk[i++];
  /** @param {string} v */ const eat = (v) => { const t = peek(); if (!t || t.v !== v) fail(`expected "${v}"`, src, t ? t.p : src.length); i++; };
  /** @returns {Node} */ const orE = () => { let a = andE(); while (peek()?.v === "or") { next(); a = { t: "bin", op: "or", a, b: andE() }; } return a; };
  /** @returns {Node} */ const andE = () => { let a = notE(); while (peek()?.v === "and") { next(); a = { t: "bin", op: "and", a, b: notE() }; } return a; };
  /** @returns {Node} */ const notE = () => (peek()?.v === "not" ? (next(), { t: "not", a: notE() }) : cmpE());
  /** @returns {Node} */ const cmpE = () => { const a = addE(); const t = peek(); if (t && CMP.includes(t.v)) { next(); return { t: "bin", op: t.v, a, b: addE() }; } return a; };
  /** @returns {Node} */ const addE = () => { let a = atom(); while (peek() && (peek().v === "+" || peek().v === "-")) { const op = next().v; a = { t: "bin", op, a, b: atom() }; } return a; };
  /** @returns {Node} */
  const atom = () => {
    const t = next(); if (!t) fail("unexpected end", src, src.length);
    if (t.k === "num") return { t: "num", v: parseFloat(t.v) };
    if (t.k === "str") return { t: "str", v: t.v };
    if (t.v === "(") { const e = orE(); eat(")"); return e; }
    if (t.k === "id") {
      if (t.v === "true" || t.v === "false") return { t: "bool", v: t.v === "true" };
      if (peek()?.v === "(") {
        if (!FUNCTIONS.includes(t.v)) fail(`unknown function "${t.v}" (allowed: ${FUNCTIONS.join(", ")})`, src, t.p);
        next(); /** @type {Node[]} */ const args = [];
        if (peek()?.v !== ")") { args.push(orE()); while (peek()?.v === ",") { next(); args.push(orE()); } }
        eat(")"); return { t: "call", fn: t.v, args };
      }
      return { t: "id", v: t.v };
    }
    return fail(`unexpected "${t.v}"`, src, t.p);
  };
  const tree = orE();
  if (i < tk.length) fail(`unexpected "${tk[i].v}"`, src, tk[i].p);
  return tree;
}

/** Parse a region selector. @param {string | undefined} sel @returns {Selector} */
export function parseSelector(sel) {
  const s = (sel ?? "all").trim().toLowerCase();
  if (s === "all" || s === "*") return { kind: "all" };
  let m;
  if ((m = /^row (\d)$/.exec(s))) return { kind: "row", r: +m[1] };
  if ((m = /^col(?:umn)? (\d)$/.exec(s))) return { kind: "col", c: +m[1] };
  if ((m = /^cell (\d) (\d)$/.exec(s))) return { kind: "cell", r: +m[1], c: +m[2] };
  if ((m = /^region ([a-z0-9_-]{1,40})$/.exec(s))) return { kind: "region", id: m[1] };
  throw new Error(`unknown selector "${sel}" (use all, row N, col N, cell R C or region NAME)`);
}

/** @param {Selector} sel @param {{ r: number, c: number, id?: string }} cell */
export const selects = (sel, cell) => sel.kind === "all" || (sel.kind === "row" && cell.r === sel.r - 1) ||
  (sel.kind === "col" && cell.c === sel.c - 1) || (sel.kind === "cell" && cell.r === sel.r - 1 && cell.c === sel.c - 1) ||
  (sel.kind === "region" && (cell.id || "").toLowerCase() === sel.id);

/** Identifiers an expression reads. @param {Node} n @param {Set<string>} [acc] */
export function idents(n, acc = new Set()) {
  if (n.t === "id") acc.add(n.v);
  else if (n.t === "call") n.args.forEach((a) => idents(a, acc));
  else if (n.t === "not") idents(n.a, acc);
  else if (n.t === "bin") { idents(n.a, acc); idents(n.b, acc); }
  return acc;
}

/**
 * Check that an expression only reads what exists in its context.
 * @param {Node} tree @param {"region" | "box"} scope
 * @param {{ params: string[], questions: Record<string, "yesno" | "count"> }} ctx
 */
export function validate(tree, scope, ctx) {
  /** @param {Node} n @param {boolean} inAgg */
  const walk = (n, inAgg) => {
    if (n.t === "id") {
      const v = n.v;
      if (v.startsWith("param.")) { if (!ctx.params.includes(v.slice(6))) throw new Error(`unknown parameter "${v}" (defined: ${ctx.params.join(", ") || "none"})`); return; }
      if (v.startsWith("q.")) { if (!(v.slice(2) in ctx.questions)) throw new Error(`unknown question "${v}" (defined: ${Object.keys(ctx.questions).join(", ") || "none"})`); if (scope === "box" && !inAgg) throw new Error(`"${v}" is a per-region measurement: use it in a rule with "for", or inside total()`); return; }
      if (v === "count" || v === "colour") { if (scope === "box" && !inAgg) throw new Error(`"${v}" is a per-region measurement: use it in a rule with "for", or inside total()/distinct()`); return; }
      if (v === "walls.missing") return;
      throw new Error(`unknown name "${v}" (measurements: count, colour, q.<question>, walls.missing; values: param.<name>)`);
    }
    if (n.t === "call") {
      if (scope === "region") throw new Error(`${n.fn}() is a box function: use it in a rule without "for"`);
      if (n.args.length < 1 || n.args.length > 2) throw new Error(`${n.fn}() takes a measurement and an optional "selector"`);
      const m = n.args[0];
      if (m.t !== "id") throw new Error(`${n.fn}() needs a measurement name as its first argument`);
      if (n.fn === "total" && !(m.v === "count" || (m.v.startsWith("q.") && m.v.slice(2) in ctx.questions))) throw new Error(`total() sums count or a q.<question>`);
      if (n.fn === "distinct" && m.v !== "colour") throw new Error(`distinct() counts colour`);
      walk(m, true);
      if (n.args[1]) { if (n.args[1].t !== "str") throw new Error(`${n.fn}()'s second argument must be a "selector"`); parseSelector(n.args[1].v); }
      return;
    }
    if (n.t === "not") return walk(n.a, inAgg);
    if (n.t === "bin") { walk(n.a, inAgg); walk(n.b, inAgg); }
  };
  walk(tree, false);
}

// ---------------- evaluation ----------------
/** @typedef {number | string | boolean | null} Val */

/** @param {Node} n @param {(name: string) => Val} get @param {(n: Node & { t: "call" }) => Val} call @returns {Val} */
function ev(n, get, call) {
  switch (n.t) {
    case "num": case "str": case "bool": return n.v;
    case "id": return get(n.v);
    case "call": return call(n);
    case "not": { const a = ev(n.a, get, call); return a === null ? null : !a; }
    case "bin": {
      if (n.op === "and" || n.op === "or") {
        const a = ev(n.a, get, call), b = ev(n.b, get, call);
        if (a === null || b === null) return null;
        return n.op === "and" ? (!!a && !!b) : (!!a || !!b);
      }
      const a = ev(n.a, get, call), b = ev(n.b, get, call);
      if (a === null || b === null) return null;                     // unknown measurement: can't judge
      if ((n.op === "==" || n.op === "!=") && (a === "any" || b === "any")) return n.op === "==";   // "any colour": not enforced
      switch (n.op) {
        case "+": return Number(a) + Number(b);
        case "-": return Number(a) - Number(b);
        case "==": return a === b; case "!=": return a !== b;
        case "<": return a < b; case "<=": return a <= b; case ">": return a > b; case ">=": return a >= b;
      }
    }
  }
  return null;
}

/** Most likely value of a distribution ({"0": p0, ...} or {"yes": p, "no": q}). @param {Record<string, number>} d */
const argmax = (d) => Object.entries(d).sort((a, b) => b[1] - a[1])[0][0];
/** @param {string} k */ const asVal = (k) => (k === "yes" ? true : k === "no" ? false : /^\d+$/.test(k) ? parseInt(k, 10) : k);

/**
 * Probability that a per-region test holds, enumerating the region's random measurements (Gemma's answer
 * distributions); deterministic values (colour, parameters) are plugged in. Returns null if it can't be judged.
 * @param {Node} tree @param {Record<string, Record<string, number> | null>} dists measurement -> distribution
 * @param {Record<string, Val>} fixed measurement/param -> value
 */
export function probability(tree, dists, fixed) {
  const names = [...idents(tree)].filter((v) => v in dists);
  if (names.some((v) => !dists[v])) return null;
  /** @type {[string, [string, number][]][]} */ const axes = names.map((v) => [v, Object.entries(/** @type {Record<string, number>} */ (dists[v]))]);
  let pTrue = 0, pKnown = 0;
  /** @param {number} k @param {Record<string, Val>} vals @param {number} p */
  const rec = (k, vals, p) => {
    if (p < 1e-6) return;
    if (k === axes.length) {
      const r = ev(tree, (nm) => (nm in vals ? vals[nm] : nm in fixed ? fixed[nm] : null), () => null);
      if (r !== null) { pKnown += p; if (r) pTrue += p; }
      return;
    }
    const [nm, entries] = axes[k];
    for (const [key, q] of entries) rec(k + 1, { ...vals, [nm]: asVal(key) }, p * q);
  };
  rec(0, {}, 1);
  return pKnown > 0.5 ? pTrue / pKnown : null;
}

/**
 * Evaluate a box-level test on the most likely answers. Returns the boolean (or null) and the values it used.
 * @param {Node} tree
 * @param {{ cells: { r: number, c: number, id?: string, dists: Record<string, Record<string, number> | null>, colour?: string | null }[], wallsMissing: number, params: Record<string, Val> }} box
 *   (colour: a name, null for "measured, no pin", undefined for "not measured")
 * @returns {{ ok: Val, used: Record<string, Val> }}
 */
export function evalBox(tree, box) {
  /** @type {Record<string, Val>} */ const used = {};
  const get = (/** @type {string} */ nm) => {
    if (nm === "walls.missing") return (used[nm] = box.wallsMissing);
    if (nm.startsWith("param.")) return box.params[nm.slice(6)] ?? null;
    return null;
  };
  const call = (/** @type {Node & { t: "call" }} */ n) => {
    const m = /** @type {{ t: "id", v: string }} */ (n.args[0]).v;
    const sel = parseSelector(n.args[1] && n.args[1].t === "str" ? n.args[1].v : "all");
    const cells = box.cells.filter((c) => selects(sel, c));
    const label = `${n.fn}(${m}${n.args[1] && n.args[1].t === "str" ? `, "${n.args[1].v}"` : ""})`;
    if (n.fn === "distinct") {                                       // colours not measured (undefined): unknown, not zero
      if (cells.some((c) => c.colour === undefined)) return (used[label] = null);
      return (used[label] = new Set(cells.map((c) => c.colour).filter(Boolean)).size);
    }
    let sum = 0;
    for (const c of cells) {
      const d = c.dists[m]; if (!d) return (used[label] = null);
      const v = asVal(argmax(d)); sum += typeof v === "boolean" ? (v ? 1 : 0) : Number(v);
    }
    return (used[label] = sum);
  };
  return { ok: ev(tree, get, call), used };
}

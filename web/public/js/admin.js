// @ts-check
// Admin: the rule builder, laid out as  inputs -> planner output -> verification -> approval.
// Inputs: the engineer's written specification, a sample image and the planner model. Process sends them to the
// Inspection Planner (Gemini on Vertex AI, structured JSON), which returns two programs the line executes: the region
// program (how photos are divided: a fixed set of operations, validated and interpreted server-side) and the rules. Verification: the sample divided into regions, and
// accuracy on labelled images (not possible for mock images). Only approved versions run on the production line.
import { $, $input, $select, $button } from "./dom.js";
import { state } from "./state.js";
import { parseRuleSet, ruleSetToJson, ruleText, checkerOf, evaluateRuleSet } from "./ruleset.js";
import { approved, approve, onApprovedChanged, DEFAULT_PROGRAM, wallMinOf } from "./spec.js";
import { measureAccuracy } from "./accuracy.js";
import { boxImage } from "./data.js";
/** @typedef {import("../../types/model").Entry} Entry */
/** @typedef {import("../../types/model").RuleSetV2} RuleSetV2 */
/** @typedef {import("../../types/model").RegionProgram} RegionProgram */
/** @typedef {import("../../types/model").Layout} Layout */
/** @typedef {import("../../types/model").AccuracyReport} AccuracyReport */

/**
 * The draft: the region program and the rules (with sensitivity), both from their JSON boxes, plus the layout the
 * program resolved to on the current sample.
 * @type {{ program: RegionProgram, ruleset: RuleSetV2 | null, rulesValid: boolean, progValid: boolean, layout: Layout | null }}
 */
const draft = { program: structuredClone(DEFAULT_PROGRAM), ruleset: null, rulesValid: true, progValid: true, layout: null };
const valid = () => draft.rulesValid && draft.progValid;
/** @type {AccuracyReport | null} */ let report = null;
/** @type {{ entry: Entry | null, canvas: HTMLCanvasElement, w: number, h: number, labelled: boolean } | null} */ let sample = null;
let stale = false;                                   // inputs changed since the last Process
/** @type {{ model: string, seconds: number } | null} */ let plannedBy = null;
/** @type {{ prog: string, rules: string } | null} */ let restoreOnFail = null;
let planning = false;
/** @type {{ name: string, url: string, entry?: Entry }[]} */ let samples = [];
const esc = (/** @type {string} */ s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] || c);

/** True when the program is the plain grid-from-walls kind the recordings were analysed with. */
const isRecordedKind = () => draft.program.steps.some((st) => st.op === "grid_from_walls") &&
                             !draft.program.steps.some((st) => st.op === "fixed_regions");

function renderPlan() {
  const l = draft.layout;
  $("ad-plan-text").textContent = !draft.progValid ? "fix the region program first"
    : l ? `${l.rows} × ${l.cols} regions${sample && sample.entry ? `, ${sample.entry.walls.length} walls` : ""}` : "press Process";
}

function renderRules() {
  const rs = draft.ruleset;
  if (!rs) { $("ad-rule-list").innerHTML = ""; $("ad-rule-meta").innerHTML = ""; return; }
  const ops = Object.entries(rs.params).filter(([, p]) => p.operator).map(([k, p]) => `${p.label || k} (default ${p.default})`);
  $("ad-rule-list").innerHTML = rs.rules.map((r) =>
    `<li class="${r.on === false ? "off" : ""}"><b class="mono">${esc(r.id)}</b> ${esc(ruleText(r))}<span class="tag">${esc(checkerOf(r))}</span>` +
    `<div class="mono muted expr">${r.for !== undefined ? `for ${esc(r.for)}: ` : ""}${esc(r.test)}</div></li>`).join("");
  $("ad-rule-meta").innerHTML =
    (ops.length ? `<p><span class="tag op-tag">operator settings</span> ${esc(ops.join(", "))}</p>` : "") +
    (rs.questions.length ? `<p><span class="tag">questions to Gemma</span> ${rs.questions.map((q) => `<b>q.${esc(q.id)}</b> "${esc(q.text)}" (${q.answer})`).join("; ")}</p>` : "");
}

/** Draw the sample photo with numbered regions, walls and, when Gemma's answers are known, the draft verdict. */
function drawSample() {
  const cv = /** @type {HTMLCanvasElement} */ ($("ad-canvas")), g = cv.getContext("2d");
  if (!g || !sample) return;
  const W = cv.width, H = Math.round(W * sample.h / sample.w); if (cv.height !== H) cv.height = H;
  g.drawImage(sample.canvas, 0, 0, W, H);
  const e = sample.entry, s = W / sample.w, wallMin = wallMinOf(draft.program);
  if (!e) { $("ad-sample-note").textContent = "not divided yet · press Process to run the planner on this sample"; return; }
  if (!draft.ruleset) return;
  const res = evaluateRuleSet(e, null, draft.ruleset, draft.ruleset.sensitivity, wallMin);
  g.font = `600 ${Math.round(W / 34)}px "JetBrains Mono", monospace`;
  res.cells.forEach((c, i) => {
    const [x0, y0, x1, y1] = c.box;
    const col = c.flagged ? "#ff4d4f" : c.dist ? "#36c275" : "#4fb3ff";
    g.strokeStyle = col; g.lineWidth = 3; g.strokeRect(x0 * s, y0 * s, (x1 - x0) * s, (y1 - y0) * s);
    g.fillStyle = "rgba(0,0,0,.6)"; g.fillRect(x0 * s + 4, y0 * s + 4, W / 13, W / 30);
    g.fillStyle = col; g.fillText(c.dist ? `#${i + 1}:${c.count}` : `#${i + 1}`, x0 * s + 8, y0 * s + W / 34 + 2);
  });
  for (const w of e.walls) {
    const missing = w.strength < wallMin;
    g.strokeStyle = missing ? "#ff9f1c" : "rgba(79,179,255,.55)"; g.lineWidth = missing ? 6 : 2;
    g.beginPath();
    if (w.o === "v") { g.moveTo(e.xs[w.c + 1] * s, e.ys[w.r] * s); g.lineTo(e.xs[w.c + 1] * s, e.ys[w.r + 1] * s); }
    else { g.moveTo(e.xs[w.c] * s, e.ys[w.r + 1] * s); g.lineTo(e.xs[w.c + 1] * s, e.ys[w.r + 1] * s); }
    g.stroke();
  }
  $("ad-sample-note").textContent = !e.cells.some((c) => c.dist)
    ? `${e.cells.length} regions and ${e.walls.length} walls found · counting rules need Gemma, so they are checked in Live`
    : `${res.failed ? "FAIL" : "PASS"} under the draft rules · ground truth: ${e.label ? "logical anomaly" : "good"}`;
}

/** Accuracy on the recorded, labelled images, or why it can't be measured. */
function updateAccuracy() {
  const labelledSet = $select("ad-imageset").value === "recorded", box = $input("ad-measure"), out = $("ad-accuracy");
  box.disabled = !labelledSet; if (!labelledSet) box.checked = false;
  report = null;
  if (!valid()) { out.innerHTML = `<p class="muted">Fix the JSON first.</p>`; return; }
  if (!labelledSet) { out.innerHTML = `<p class="muted">Mock or sample photos have no ground truth, so accuracy can't be measured. The verification panel still shows how they are divided.</p>`; return; }
  if (!box.checked) { out.innerHTML = `<p class="muted">Accuracy not measured.</p>`; return; }
  if (!isRecordedKind() || (draft.layout && (draft.layout.rows !== 3 || draft.layout.cols !== 5))) {
    out.innerHTML = `<p class="muted">The recordings were divided by a 3 × 5 grid-from-walls program; accuracy on them can only be measured for that kind of program.</p>`; return;
  }
  if (!draft.ruleset) return;
  report = measureAccuracy(state.entries, draft.ruleset, draft.ruleset.sensitivity, wallMinOf(draft.program));
  const pct = (/** @type {number} */ x) => (x * 100).toFixed(1) + "%";
  out.innerHTML = `
    <div class="acc-kpis">
      <div><b>${pct(report.accuracy)}</b><span>accuracy</span></div>
      <div><b>${report.auroc != null ? (report.auroc * 100).toFixed(1) : "–"}</b><span>AUROC</span></div>
      <div><b>${pct(report.recall)}</b><span>anomalies caught</span></div>
      <div><b>${pct(report.false_alarm)}</b><span>false alarms</span></div>
    </div>
    <table class="acc-cm"><tr><th></th><th>rejected</th><th>passed</th></tr>
      <tr><th>anomaly</th><td class="good">${report.tp}</td><td class="bad">${report.fn}</td></tr>
      <tr><th>good</th><td class="bad">${report.fp}</td><td class="good">${report.tn}</td></tr></table>
    <p class="muted">${report.images} (MVTec LOCO pushpins, 6 colour/lighting variants), recorded Gemma 4 answers${report.note ? `; ${report.note}` : ""}.</p>`;
}

function isDirty() {
  const a = JSON.stringify({ r: draft.ruleset, p: draft.program, s: $input("ad-spec").value.trim() });
  const b = JSON.stringify({ r: approved.ruleset, p: approved.program, s: approved.specText.trim() });
  return a !== b;
}

function updateStatus() {
  const dirty = isDirty();
  $("ad-status").textContent = (approved.version ? `Live inspections run approved v${approved.version} (Replay keeps its fixed rules). ` : "Live inspections run the default specification. ") +
                               (!valid() ? "The draft JSON has errors." : dirty ? "The draft has unapproved changes." : "The draft matches it.");
  $button("ad-approve").disabled = !valid() || (!dirty && approved.version > 0);
  $button("ad-discard").disabled = !dirty;
}

function renderStale() {
  const tag = $("ad-out-tag");
  tag.classList.toggle("stale", stale && !planning);
  tag.textContent = planning ? "planning…" : stale ? "inputs changed · press Process"
    : plannedBy ? `planned by ${plannedBy.model} · ${plannedBy.seconds} s` : "planner output";
}

function refresh() { renderStale(); renderPlan(); renderRules(); drawSample(); updateAccuracy(); updateStatus(); }

/** Read the JSON box into the draft (shows the first validation error instead, if any). */
function readJson() {
  try {
    draft.ruleset = parseRuleSet($input("ad-json").value); draft.rulesValid = true;
    $("ad-json-error").textContent = "";
  } catch (e) {
    draft.rulesValid = false; $("ad-json-error").textContent = e instanceof Error ? e.message : String(e);
  }
  refresh();
}

/** Read the region program box into the draft (light client check; the server validates fully when it runs it). */
function readProgram() {
  try {
    const p = JSON.parse($input("ad-prog").value);
    if (!p || p.program !== "region-plan/v1" || !Array.isArray(p.steps) || !p.steps.length) throw new Error(`expected {"program": "region-plan/v1", "steps": [...]}`);
    const ops = ["normalize_light", "grid_from_walls", "fixed_regions", "wall_segments"];
    p.steps.forEach((/** @type {any} */ st, /** @type {number} */ i) => { if (!st || !ops.includes(st.op)) throw new Error(`step ${i + 1}: unknown operation "${st && st.op}" (allowed: ${ops.join(", ")})`); });
    draft.program = p; draft.progValid = true; $("ad-prog-error").textContent = "";
  } catch (e) {
    draft.progValid = false; $("ad-prog-error").textContent = e instanceof Error ? e.message : String(e);
  }
  stale = true; refresh();
}

/**
 * Load a sample. With divide=false only the photo is shown (until Process); with divide=true the planner's region step
 * runs: a recorded photo comes with its analysis (labelled, with Gemma's answers); any other photo is divided by the
 * server, which detects the layout.
 * @param {number} i @param {boolean} [divide]
 */
async function loadSample(i, divide = true) {
  const it = samples[i]; if (!it) return;
  if (!divide) {
    try {
      const canvas = it.entry ? (await boxImage(it.entry)).canvas : await photoCanvas(it.url);
      sample = { entry: null, canvas, w: canvas.width, h: canvas.height, labelled: !!it.entry };
      refresh();
    } catch (e) { $("ad-sample-note").textContent = `could not open this photo: ${e instanceof Error ? e.message : e}`; }
    return;
  }
  $("ad-sample-note").textContent = "dividing the photo into regions…";
  try {
    if (!draft.progValid) throw new Error("fix the region program first");
    if (it.entry && isRecordedKind()) {               // recorded photo: same kind of program, with Gemma's recorded answers
      const im = await boxImage(it.entry);
      sample = { entry: it.entry, canvas: im.canvas, w: im.w, h: im.h, labelled: true };
    } else {                                          // run the draft region program on the photo (server, geometry only)
      const c = it.entry ? (await boxImage(it.entry)).canvas : await photoCanvas(it.url);
      const r = await fetch("api/regions", { method: "POST", headers: { "Content-Type": "application/json" },
                                             body: JSON.stringify({ image: c.toDataURL("image/jpeg", 0.9), program: draft.program }) });
      if (!r.ok) { const d = (await r.json().catch(() => ({}))).detail; throw new Error(Array.isArray(d) ? d.map((x) => x.msg).join("; ") : d || `HTTP ${r.status}`); }
      sample = { entry: await r.json(), canvas: c, w: c.width, h: c.height, labelled: false };
    }
    if (sample.entry) draft.layout = { rows: sample.entry.rows, cols: sample.entry.cols };
    refresh();
  } catch (e) { $("ad-sample-note").textContent = `could not divide this photo: ${e instanceof Error ? e.message : e}`; }
}

/** A photo URL as a canvas, scaled to at most 1700 px wide. @param {string} url @returns {Promise<HTMLCanvasElement>} */
async function photoCanvas(url) {
  /** @type {HTMLImageElement} */
  const img = await new Promise((res, rej) => { const x = new Image(); x.onload = () => res(x); x.onerror = rej; x.src = url; });
  const c = document.createElement("canvas"), k = Math.min(1, 1700 / img.naturalWidth);
  c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
  c.getContext("2d")?.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

/**
 * POST JSON to an admin endpoint; asks for the admin token once if the deployment requires one.
 * @param {string} url @param {object} body @returns {Promise<any>}
 */
async function adminPost(url, body) {
  const go = (/** @type {string} */ token) => fetch(url, { method: "POST", body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", "X-Admin-Token": token } });
  let token = sessionStorage.getItem("spec2inspect.admin") || "";
  let r = await go(token);
  if (r.status === 403) {
    token = prompt("Admin token required:") || ""; if (!token) throw new Error("admin token required");
    r = await go(token); if (r.ok) sessionStorage.setItem("spec2inspect.admin", token);
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(Array.isArray(data.detail) ? data.detail.map((/** @type {any} */ x) => x.msg).join("; ") : data.detail || `HTTP ${r.status}`);
  return data;
}

/**
 * Every sentence of the specification and what the planner did with it; gaps and warnings are highlighted.
 * @param {{ sentences?: { id: string, text: string }[], coverage?: { sentence: string, how: string, rules?: string[], params?: string[], reason?: string }[], warnings?: string[] }} plan
 */
function renderCoverage(plan) {
  const box = $("ad-coverage");
  if (!plan.sentences?.length) { box.hidden = true; return; }
  const byId = Object.fromEntries((plan.coverage || []).map((c) => [c.sentence.toUpperCase(), c]));
  const how = (/** @type {any} */ c) => !c ? "not covered"
    : c.how === "rule" ? `rule ${c.rules.join(", ")}`
    : c.how === "operator_setting" ? `operator setting: ${c.params.join(", ")}${c.rules?.length ? ` (${c.rules.join(", ")})` : ""}`
    : c.how === "layout" ? "region program" : `not expressible${c.reason ? `: ${c.reason}` : ""}`;
  box.innerHTML = `<table><tr><th>Sentence</th><th>Checked by</th></tr>${plan.sentences.map((t) => {
    const c = byId[t.id], gap = !c || c.how === "not_expressible";
    return `<tr class="${gap ? "gap" : ""}"><td><b class="mono">${esc(t.id)}</b> ${esc(t.text)}</td><td class="how">${esc(how(c))}</td></tr>`;
  }).join("")}</table>` + (plan.warnings?.length ? `<p class="warn">Check before approving: ${esc(plan.warnings.join("; "))}</p>` : "");
  box.hidden = false;
}

/** Run the Inspection Planner on the inputs: Gemini returns the region program and rules; then divide the sample. */
async function processInputs() {
  const btn = $button("ad-process"), notes = $("ad-plan-notes");
  btn.disabled = true; btn.textContent = "Planning…";
  notes.hidden = false; notes.textContent = `Asking ${$select("ad-model").value} to plan the inspection…`;
  try {
    const it = samples[parseInt($select("ad-sample").value, 10)];
    const canvas = it.entry ? (await boxImage(it.entry)).canvas : await photoCanvas(it.url);
    const model = $select("ad-model").value;
    planning = true; renderStale();
    const progBox = $input("ad-prog"), rulesBox = $input("ad-json");
    const before = { prog: progBox.value, rules: rulesBox.value };          // restored if planning fails
    restoreOnFail = before;
    const { id } = await adminPost("api/plan", { spec_text: $input("ad-spec").value.trim(), model, image: canvas.toDataURL("image/jpeg", 0.9) });
    /** @param {{ thoughts: string, output: string, attempts: number } | null | undefined} st @param {string} what */
    const streamText = (st, what) => !st ? `Waiting for the ${what}…`
      : `Thinking${st.attempts > 1 ? ` (attempt ${st.attempts})` : ""}:\n${st.thoughts || "…"}${st.output ? `\n\nOutput so far:\n${st.output}` : ""}`;
    /** @type {any} */ let plan = null;
    let regionsShown = false;
    const t0 = Date.now();
    progBox.classList.add("streaming"); rulesBox.classList.add("streaming");
    while (!plan) {                                      // planning runs as a job; poll its streamed thinking
      await new Promise((res) => setTimeout(res, 700));
      const r = await fetch(`api/plan/${id}`, { cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.detail || `HTTP ${r.status}`);
      if (j.state === "error") throw new Error(j.error);
      if (j.region_result && !regionsShown) {          // regions planned: show the program and divide the sample now
        regionsShown = true; progBox.classList.remove("streaming");
        progBox.value = JSON.stringify(j.region_result.program, null, 2); readProgram();
        loadSample(parseInt($select("ad-sample").value, 10), true);
      } else if (!regionsShown) {
        progBox.value = streamText(j.regions, "region planner"); progBox.scrollTop = progBox.scrollHeight;
      }
      if (j.state === "done") { plan = j.result; break; }
      if (regionsShown) { rulesBox.value = streamText(j.rules, "rules planner"); rulesBox.scrollTop = rulesBox.scrollHeight; }
      else rulesBox.value = "Waiting for the regions to be planned first…";
      const sec = Math.round(j.elapsed ?? (Date.now() - t0) / 1000);
      notes.textContent = j.stage === "rules" ? `${model} is planning the rules… ${sec} s` : `${model} is planning the regions… ${sec} s`;
      if (Date.now() - t0 > 10 * 60000) throw new Error("the planner took longer than 10 minutes");
    }
    progBox.classList.remove("streaming"); rulesBox.classList.remove("streaming");
    restoreOnFail = null;
    $input("ad-prog").value = JSON.stringify(plan.program, null, 2); readProgram();
    $input("ad-json").value = ruleSetToJson(plan.ruleset); readJson();
    plannedBy = { model: plan.model, seconds: plan.seconds };
    notes.textContent = (plan.notes ? `Planner notes: ${plan.notes}` : "The planner added no notes.") +
                        (plan.attempts > 2 ? ` (${plan.attempts} calls: an answer was corrected or retried)` : "");
    renderCoverage(plan);
    btn.textContent = "Dividing the sample…";
    await loadSample(parseInt($select("ad-sample").value, 10), true);
    stale = false; refresh();
  } catch (e) {
    if (restoreOnFail) {                                 // put back what was there before the stream replaced it
      $input("ad-prog").value = restoreOnFail.prog; $input("ad-json").value = restoreOnFail.rules; restoreOnFail = null;
      $("ad-prog").classList.remove("streaming"); $("ad-json").classList.remove("streaming"); readProgram(); readJson();
    }
    notes.textContent = `Planning failed: ${e instanceof Error ? e.message : e}. The previous output is unchanged.`;
  } finally { planning = false; renderStale(); btn.disabled = false; btn.textContent = "Process"; }
}

function discardDraft() {
  plannedBy = null; $("ad-plan-notes").hidden = true; $("ad-coverage").hidden = true;
  $input("ad-spec").value = approved.specText;
  $input("ad-prog").value = JSON.stringify(approved.program, null, 2); readProgram();
  $input("ad-json").value = ruleSetToJson(approved.ruleset); readJson();
  stale = false;
  loadSample(parseInt($select("ad-sample").value || "0", 10), true);
}

async function doApprove() {
  if (!confirm(`Approve this specification and send it to the production line?${report ? `\n\nAccuracy ${(report.accuracy * 100).toFixed(1)}% on ${report.n} labelled images.` : "\n\nAccuracy was not measured."}`)) return;
  /** @param {string} token */
  const send = (token) => approve({ program: draft.program, layout: draft.layout, ruleset: /** @type {RuleSetV2} */ (draft.ruleset),
                                    accuracy: report, specText: $input("ad-spec").value.trim() }, token);
  try {
    let token = sessionStorage.getItem("spec2inspect.admin") || "";
    try { await send(token); }
    catch (e) {
      if (!(e && /** @type {any} */ (e).code === 403)) throw e;
      token = prompt("Admin token required to approve:") || ""; if (!token) return;
      await send(token); sessionStorage.setItem("spec2inspect.admin", token);
    }
    // show exactly what the server stored (it fills in defaults), so the draft matches the approved version
    $input("ad-prog").value = JSON.stringify(approved.program, null, 2); readProgram();
    $input("ad-json").value = ruleSetToJson(approved.ruleset); readJson();
    stale = false; refresh();
  } catch (e) { alert(`Could not approve: ${e instanceof Error ? e.message : e}`); }
}

/** @param {{ name: string, url: string }[]} trayPhotos sample photos (no labels) */
export function initAdmin(trayPhotos) {
  fetch("api/plan/models").then((r) => r.json()).then((d) => {
    if (d.models?.length) $("ad-model").innerHTML = d.models.map((/** @type {string} */ m) => `<option value="${esc(m)}">${esc(m)}</option>`).join("");
  }).catch(() => {});
  const originals = state.entries.filter((e) => e.color === "Original" && !e.stops);
  const rec = [...originals.filter((e) => e.label === 0).slice(0, 4), ...originals.filter((e) => e.label === 1).slice(0, 6)];
  samples = [...rec.map((e) => ({ name: `${e.img_id} · recorded, labelled`, url: "", entry: e })),
             ...trayPhotos.map((t) => ({ name: `${t.name} · sample photo, no labels`, url: t.url }))];
  $("ad-sample").innerHTML = samples.map((s, i) => `<option value="${i}">${esc(s.name)}</option>`).join("");
  $("ad-sample").addEventListener("change", () => { stale = true; loadSample(parseInt($select("ad-sample").value, 10), false); });
  $("ad-spec").addEventListener("input", () => { stale = true; renderStale(); updateStatus(); });
  $("ad-process").addEventListener("click", processInputs);
  $("ad-json").addEventListener("input", readJson);
  /** Toggle a JSON box between read-only and editable. @param {string} btnId @param {string} boxId */
  const editable = (btnId, boxId) => $(btnId).addEventListener("click", () => {
    const ta = $input(boxId), start = ta.readOnly;
    ta.readOnly = !start; ta.classList.toggle("editing", start);
    $(btnId).textContent = start ? "Done" : "Edit";
    if (start) ta.focus(); else if (boxId === "ad-prog" && draft.progValid) loadSample(parseInt($select("ad-sample").value, 10), true);
  });
  editable("ad-edit-json", "ad-json"); editable("ad-edit-prog", "ad-prog");
  $("ad-prog").addEventListener("input", readProgram);
  $("ad-imageset").addEventListener("change", refresh);
  $("ad-measure").addEventListener("change", refresh);
  $("ad-discard").addEventListener("click", discardDraft);
  $("ad-approve").addEventListener("click", doApprove);
  onApprovedChanged(updateStatus);
  discardDraft();
}

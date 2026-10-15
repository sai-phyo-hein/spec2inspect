// @ts-check
// The inspection station: clamp, capture, analyse (recorded or live), apply the rules, signal the diverter.
import { $ } from "./dom.js";
import { state, wait, whileRunning } from "./state.js";
import { evaluateRuleSet } from "./ruleset.js";
import { cellColours } from "./colours.js";
import { variantText } from "./data.js";
import { clearShot, drawShot, drawMatrix, setVerdict, setVerdictMessage, setStep, resetSteps, showImage } from "./panel.js";
import { clamp, tower, flash, packet } from "./scene.js";
import { log, updateKpis } from "./log.js";
import { recordCheck } from "./history.js";
import { approved, onApprovedChanged, wallMinOf, REPLAY_RULESET, REPLAY_WALL_MIN } from "./spec.js";
/** @typedef {import("../../types/model").Box} Box */
/** @typedef {import("../../types/model").RuleSet} RuleSet */
/** @typedef {import("../../types/model").Evaluation} Evaluation */
/** @typedef {import("../../types/model").Entry} Entry */

/**
 * Recorded boxes (Replay) are always judged by the fixed replay rules; photos inspected live use the approved
 * specification, with the operator's settings. @param {Box} b @returns {Evaluation}
 */
const applyRules = (b) => b.upload
  ? evaluateRuleSet(b.entry, b.colors, approved.ruleset, approved.ruleset.sensitivity, wallMinOf(approved.program), approved.operator)
  : evaluateRuleSet(b.entry, b.colors, REPLAY_RULESET, REPLAY_RULESET.sensitivity, REPLAY_WALL_MIN);

const CANCELLED = new Error("box removed from the line");

/**
 * Inspection steps for one box: each marks itself running, does its work, then marks itself done with its duration.
 * If the box is taken off the line (switching to Live), its remaining steps are skipped.
 * @param {Box} b
 */
const stepper = (b) => /** @param {string} key @param {() => Promise<void>} work */ (key, work) => async () => {
  if (b.cancelled) throw CANCELLED;
  await whileRunning(); setStep(key, "run");
  const t = performance.now(); await work();
  if (b.cancelled) throw CANCELLED;
  setStep(key, "done", Math.round((performance.now() - t) * state.speed));
};

/** The panel when Live mode is waiting for a photo. */
export function showWaiting() {
  resetSteps(); drawMatrix(null, 0); clearShot("waiting for a photo…");
  $("cur-id").textContent = "waiting for a photo"; $("shot-variant").textContent = "–"; $("shot-truth").textContent = "–";
  setVerdictMessage("WAITING FOR A PHOTO", "Drag a photo onto the drop zone at the infeed, or upload one. It is inspected when it reaches the camera.");
  $("line-status").textContent = "RUNNING";
}

/** Inspect the box clamped at the camera, then release it towards the diverter. @param {Box} b */
export async function inspect(b) {
  try { await inspectRecorded(b); }
  catch (e) { if (e !== CANCELLED) throw e; }       // taken off the line: Live mode has already reset the panel
}

/** @param {Box} b */
async function inspectRecorded(b) {
  const step = stepper(b);
  state.station = b; b.phase = "station";
  $("line-status").textContent = "CLAMPED · INSPECTING";
  $("cur-id").textContent = `${b.entry.img_id} · box #${b.id + 1}`;
  resetSteps(); drawMatrix(null, 0); setVerdict(null, false); clearShot();
  $("shot-variant").textContent = "–"; $("shot-truth").textContent = "–";
  tower("t-a"); log(`box <b>#${b.id + 1}</b> clamped at Cam 01`);

  await step("clamp", async () => { clamp(true); await wait(550); })();
  await step("capture", async () => {
    while (!b.image) await wait(50);
    flash(true); b.el.classList.add("scanning"); await wait(160); flash(false); await wait(460);
    b.el.classList.remove("scanning");
    b.colors = cellColours(b.image, b.entry); b.result = applyRules(b); drawShot(b, 0);
    $("shot-variant").textContent = variantText(b.image.variant);
    $("shot-truth").textContent = `ground truth: ${b.entry.label ? "logical anomaly" : "good"}`;
    packet(true);
  })();
  await step("locate", async () => { await wait(320); drawShot(b, 1); })();
  await step("checks", async () => { await revealCompartments(b); })();
  await finish(b);
}

/** Light up the 15 compartments one by one. @param {Box} b */
async function revealCompartments(b) {
  const res = b.result || (b.result = applyRules(b));
  for (b.revealed = 1; b.revealed <= res.cells.length; b.revealed++) {
    await whileRunning();
    if (b.cancelled) throw CANCELLED;
    drawShot(b, 2); drawMatrix(res, b.revealed); await wait(55);
  }
}

/** Wall check, apply the rules, signal the diverter, count and log, release the box. @param {Box} b */
async function finish(b) {
  const step = stepper(b);
  await step("walls", async () => { await wait(280); drawShot(b, 3); })();
  await step("rules", async () => {
    await wait(200); b.result = applyRules(b); drawShot(b, 3); drawMatrix(b.result, 99); setVerdict(b.result, true);
    state.lastDone = b;
  })();
  const result = b.result || applyRules(b);
  await step("signal", async () => {
    packet(false); await wait(300);
    tower(result.failed ? "t-r" : "t-g");
    b.el.classList.add(result.failed ? "fail" : "pass");
    const stamp = b.el.querySelector(".stamp"); if (stamp) stamp.textContent = result.failed ? "FAIL" : "PASS";
  })();
  if (result.failed) setStep("signal", "fail");

  state.inspected++; result.failed ? state.failed++ : state.passed++;
  if (result.hasModel && b.entry.label !== null) { state.agreeN++; state.agreeOk += result.failed === (b.entry.label === 1) ? 1 : 0; }
  updateKpis();
  const first = result.findings.length ? ` · ${result.findings[0].replace(/<[^>]+>/g, "")}` : "";
  log(`box <b>#${b.id + 1}</b>${b.upload ? ` <span class="info">[your photo, live ${b.liveSeconds}s]</span>` : ""} → ` +
      `<span class="${result.failed ? "bad" : "ok"}">${result.failed ? "FAIL" : "PASS"}</span>${first} · signal sent to diverter`);

  if (b.upload) recordCheck(b, approved.ruleset, approved.version, approved.operator);   // shows up on the Check page
  clamp(false); await wait(450);
  b.phase = "toDiverter"; state.station = null;
  $("line-status").textContent = "RUNNING"; tower("t-g");
}

/**
 * Inspect an uploaded photo live, automatically when it reaches the camera.
 * @param {Box} b the uploaded box, just arrived at the camera
 * @param {(progress: (seconds: number) => void) => Promise<Entry>} analyse runs the analysis on the GPU
 */
export async function inspectUpload(b, analyse) {
  const step = stepper(b);
  state.station = b; b.phase = "station";
  $("line-status").textContent = "INSPECTING YOUR PHOTO";
  $("cur-id").textContent = `${b.name || "your photo"} · box #${b.id + 1}`;
  resetSteps(); drawMatrix(null, 0); setVerdict(null, false); clearShot();
  $("shot-variant").textContent = "your photo"; $("shot-truth").textContent = "no ground truth";
  tower("t-a");
  log(`box <b>#${b.id + 1}</b> clamped at Cam 01 · <span class="info">sent to Gemma 4 on the GPU</span>`);
  await step("clamp", async () => { clamp(true); await wait(550); })();
  await step("capture", async () => {
    flash(true); b.el.classList.add("scanning"); await wait(160); flash(false); await wait(300);
    b.el.classList.remove("scanning"); if (b.image) showImage(b.image); packet(true);
  })();
  try {
    await step("locate", async () => {
      setVerdictMessage("INSPECTING ON THE GPU…", "Finding the compartments and asking Gemma 4 about each one.");
      const raw = await analyse((s) => setVerdictMessage("INSPECTING ON THE GPU…",
        `Gemma 4 is checking 15 compartments · ${Math.round(s)} s. The first inspection after a quiet period can take a minute or two.`));
      b.entry = { ...raw, label: null }; b.liveSeconds = raw.seconds;
      if (b.image) b.colors = cellColours(b.image, b.entry);
      b.result = applyRules(b); drawShot(b, 1);
    })();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setStep("locate", "fail");
    setVerdictMessage("COULD NOT INSPECT YOUR PHOTO", msg, "fail");
    log(`<span class="bad">box #${b.id + 1}: live inspection failed (${msg}); the photo was removed</span>`);
    clamp(false); await wait(450);
    b.phase = "done"; b.el.classList.add("gone");
    state.station = null; tower("t-g"); $("line-status").textContent = "RUNNING";
    return;
  }
  await step("checks", async () => { await revealCompartments(b); })();
  await finish(b);
}

/** A newly approved spec re-applies to the last fully analysed box; a box still being analysed picks it up at its rules step. */
onApprovedChanged(() => reapplyRules());
export function reapplyRules() {
  const b = state.station && state.station !== state.lastDone ? null : state.lastDone;
  if (!b) return;
  b.result = applyRules(b); drawShot(b, 3); drawMatrix(b.result, 99); setVerdict(b.result, true);
}

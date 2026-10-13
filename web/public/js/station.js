// @ts-check
// The inspection station: clamp, capture, analyse (recorded or live), apply the rules, signal the diverter.
import { $ } from "./dom.js";
import { state, wait, whileRunning } from "./state.js";
import { evaluate } from "./rules.js";
import { cellColours } from "./colours.js";
import { variantText } from "./data.js";
import { clearShot, drawShot, drawMatrix, setVerdict, setVerdictMessage, setStep, resetSteps, showImage } from "./panel.js";
import { clamp, tower, flash, packet } from "./scene.js";
import { log, updateKpis } from "./log.js";
import { getThreshold } from "./spec-editor.js";
import { recordCheck } from "./history.js";
/** @typedef {import("../../types/model").Box} Box */
/** @typedef {import("../../types/model").RuleSet} RuleSet */
/** @typedef {import("../../types/model").Evaluation} Evaluation */
/** @typedef {import("../../types/model").Entry} Entry */

/** @type {RuleSet | null} */ let ruleSet = null;
/** @param {RuleSet} rules */
export function initStation(rules) { ruleSet = rules; }

/** @param {Box} b @returns {Evaluation} */
const applyRules = (b) => evaluate(b.entry, b.colors, ruleSet ? ruleSet.items : [], getThreshold());

/**
 * One inspection step: marks it running, does its work, then marks it done with its duration.
 * @param {string} key @param {() => Promise<void>} work
 */
const step = (key, work) => async () => {
  await whileRunning(); setStep(key, "run");
  const t = performance.now(); await work();
  setStep(key, "done", Math.round((performance.now() - t) * state.speed));
};

/** Inspect the box clamped at the camera, then release it towards the diverter. @param {Box} b */
export async function inspect(b) {
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
    await whileRunning(); drawShot(b, 2); drawMatrix(res, b.revealed); await wait(55);
  }
}

/** Wall check, apply the rules, signal the diverter, count and log, release the box. @param {Box} b */
async function finish(b) {
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

  if (b.upload && ruleSet) recordCheck(b, ruleSet.items);       // shows up on the Check page
  clamp(false); await wait(450);
  b.phase = "toDiverter"; state.station = null; state.hold = false;
  $("line-status").textContent = "RUNNING"; tower("t-g");
}

/** An uploaded photo has been placed at the camera: show it and ask for Inspect. @param {Box} b */
export function promptUploaded(b) {
  $("cur-id").textContent = `your photo · box #${b.id + 1}`;
  resetSteps(); drawMatrix(null, 0);
  if (b.image) showImage(b.image);
  $("shot-variant").textContent = "your uploaded photo"; $("shot-truth").textContent = "no ground truth";
  tower("t-a");
  setVerdictMessage("YOUR PHOTO IS AT CAM 01", "Press <b>Inspect</b> to check it now with Gemma 4 on the GPU, against the written specification.");
}

/**
 * Inspect an uploaded photo live, then let the recorded line continue.
 * @param {Box} b the uploaded box, already at the camera
 * @param {(progress: (seconds: number) => void) => Promise<Entry>} analyse runs the analysis on the GPU
 */
export async function inspectUpload(b, analyse) {
  $("line-status").textContent = "INSPECTING YOUR PHOTO";
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
    state.station = null; state.hold = false; tower("t-g"); $("line-status").textContent = "RUNNING";
    return;
  }
  await step("checks", async () => { await revealCompartments(b); })();
  await finish(b);
}

/** Rule edits re-apply to the last fully analysed box; a box still being analysed picks them up at its rules step. */
export function reapplyRules() {
  const b = state.station && state.station !== state.lastDone ? null : state.lastDone;
  if (!b) return;
  b.result = applyRules(b); drawShot(b, 3); drawMatrix(b.result, 99); setVerdict(b.result, true);
}
// @ts-check
// The inspection station: clamp, capture, analyse (recorded or live), apply the rules, signal the diverter.
import { $ } from "./dom.js";
import { state, wait, whileRunning } from "./state.js";
import { evaluate } from "./rules.js";
import { cellColours } from "./colours.js";
import { variantText } from "./data.js";
import { clearShot, drawShot, drawMatrix, setVerdict, setStep, resetSteps } from "./panel.js";
import { clamp, tower, flash, packet } from "./scene.js";
import { liveAnalyse } from "./live.js";
import { log, updateKpis } from "./log.js";
import { getThreshold } from "./spec-editor.js";
/** @typedef {import("../../types/model").Box} Box */
/** @typedef {import("../../types/model").RuleSet} RuleSet */
/** @typedef {import("../../types/model").Evaluation} Evaluation */

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
  const livePromise = state.live ? liveAnalyse(b.entry) : null;
  b.isLive = !!livePromise;

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
  await step("checks", async () => {
    if (livePromise) {
      try {
        const raw = await livePromise;
        b.entry = { ...b.entry, ...raw };
        if (b.image) b.colors = cellColours(b.image, b.entry);
        b.result = applyRules(b); b.liveSeconds = raw.seconds;
      } catch (e) {
        b.isLive = false;
        log(`<span class="bad">box #${b.id + 1}: live analysis failed (${e instanceof Error ? e.message : e}); using the recorded answers</span>`);
      }
    }
    const res = b.result || (b.result = applyRules(b));
    for (b.revealed = 1; b.revealed <= res.cells.length; b.revealed++) {
      await whileRunning(); drawShot(b, 2); drawMatrix(res, b.revealed); await wait(55);
    }
  })();
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
  if (result.hasModel) { state.agreeN++; state.agreeOk += result.failed === (b.entry.label === 1) ? 1 : 0; }
  updateKpis();
  const first = result.findings.length ? ` · ${result.findings[0].replace(/<[^>]+>/g, "")}` : "";
  log(`box <b>#${b.id + 1}</b>${b.isLive ? ` <span class="info">[live ${b.liveSeconds}s]</span>` : ""} → ` +
      `<span class="${result.failed ? "bad" : "ok"}">${result.failed ? "FAIL" : "PASS"}</span>${first} · signal sent to diverter`);

  clamp(false); await wait(450);
  b.phase = "toDiverter"; state.station = null;
  $("line-status").textContent = "RUNNING"; tower("t-g");
}

/** Rule edits re-apply to the last fully analysed box; a box still being analysed picks them up at its rules step. */
export function reapplyRules() {
  const b = state.station && state.station !== state.lastDone ? null : state.lastDone;
  if (!b) return;
  b.result = applyRules(b); drawShot(b, 3); drawMatrix(b.result, 99); setVerdict(b.result, true);
}

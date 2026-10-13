// @ts-check
// Mutable state of the running line, shared by the scene, the station and the live controls.
/** @typedef {import("../../types/model").LineState} LineState */

/** @type {LineState} */
export const state = {
  mode: "replay",
  entries: [], playlist: [], pos: 0, imgUrl: null,
  running: true, speed: 1, live: false, hold: false,
  inspected: 0, passed: 0, failed: 0, agreeN: 0, agreeOk: 0, runMs: 0, binGood: 0, binRej: 0,
  station: null,           // box currently clamped at the camera
  lastDone: null,          // last box whose rules step finished (rule edits re-apply to it)
};

/** Wait, scaled by the line speed. @param {number} ms @returns {Promise<void>} */
export const wait = (ms) => new Promise((r) => setTimeout(r, ms / state.speed));

/** Resolves once the line is running (immediately unless paused). */
export async function whileRunning() { while (!state.running) await new Promise((r) => setTimeout(r, 100)); }

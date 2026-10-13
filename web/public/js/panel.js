// @ts-check
// The AI pipeline panel: captured image with overlays, step list, 3 x 5 result grid and verdict.
import { $, $canvas } from "./dom.js";
import { ROWS, COLS } from "./config.js";
/** @typedef {import("../../types/model").Box} Box */
/** @typedef {import("../../types/model").Evaluation} Evaluation */

const shot = $canvas("shot");
const g = /** @type {CanvasRenderingContext2D} */ (shot.getContext("2d"));

/** @param {string} [message] */
export function clearShot(message = "waiting for capture…") {
  g.fillStyle = "#000"; g.fillRect(0, 0, shot.width, shot.height);
  g.fillStyle = "#8b98a5"; g.font = `500 ${Math.round(shot.width / 30)}px "JetBrains Mono", monospace`;
  g.fillText(message, shot.width * 0.32, shot.height * 0.52);
}

/** Show a photo with no overlay (an upload before analysis). @param {import("../../types/model").BoxImage} image */
export function showImage(image) {
  const W = shot.width, H = Math.round(W * image.h / image.w);
  if (shot.height !== H) shot.height = H;
  g.drawImage(image.canvas, 0, 0, W, H);
}

/** A message in the verdict box (instructions, progress, errors). @param {string} head @param {string} html @param {"" | "pass" | "fail"} [kind] */
export function setVerdictMessage(head, html, kind = "") {
  const v = $("verdict");
  v.className = "verdict" + (kind ? " " + kind : "");
  v.innerHTML = `<div class="head">${head}</div><div style="font-size:.88rem;color:var(--muted)">${html}</div>`;
}

/**
 * Draw the captured image with overlays.
 * @param {Box} box
 * @param {0 | 1 | 2 | 3} upTo 0 image only · 1 + grid · 2 + compartments revealed so far · 3 + missing walls
 */
export function drawShot(box, upTo) {
  if (!box.image) return;
  const H = Math.round(shot.width * box.image.h / box.image.w);
  if (shot.height !== H) shot.height = H;
  renderOverlay(g, shot.width, box, upTo);
}

/**
 * Draw a box photo with its inspection overlay onto any 2D context of width W.
 * @param {CanvasRenderingContext2D} ctx @param {number} W @param {Box} box @param {0 | 1 | 2 | 3} upTo
 */
export function renderOverlay(ctx, W, box, upTo) {
  const im = box.image, e = box.entry, res = box.result;
  if (!im) return;
  const H = Math.round(W * im.h / im.w);
  ctx.drawImage(im.canvas, 0, 0, W, H);
  const s = W / im.w, lw = Math.max(2, Math.round(W / 300));
  if (upTo >= 1) {
    ctx.strokeStyle = "rgba(79,179,255,.85)"; ctx.lineWidth = 1;
    for (const x of e.xs) { ctx.beginPath(); ctx.moveTo(x * s, e.ys[0] * s); ctx.lineTo(x * s, e.ys[e.ys.length - 1] * s); ctx.stroke(); }
    for (const y of e.ys) { ctx.beginPath(); ctx.moveTo(e.xs[0] * s, y * s); ctx.lineTo(e.xs[e.xs.length - 1] * s, y * s); ctx.stroke(); }
  }
  if (upTo >= 2 && res) {
    const n = upTo === 2 ? box.revealed : res.cells.length;
    ctx.font = `600 ${Math.round(W / 26)}px "JetBrains Mono", monospace`;
    res.cells.slice(0, n).forEach((c) => {
      const [x0, y0, x1, y1] = c.box;
      const col = c.flagged ? "#ff4d4f" : c.dist ? "#36c275" : "rgba(160,170,180,.8)";
      ctx.strokeStyle = col; ctx.lineWidth = c.flagged ? lw * 2 : lw;
      ctx.strokeRect(x0 * s, y0 * s, (x1 - x0) * s, (y1 - y0) * s);
      ctx.fillStyle = col; ctx.fillText(c.count, x0 * s + 6, y0 * s + W / 24);
    });
  }
  if (upTo >= 3 && res) {
    ctx.strokeStyle = "#ff9f1c"; ctx.lineWidth = lw * 3;
    for (const w of res.missing) {
      ctx.beginPath();
      if (w.o === "v") { ctx.moveTo(e.xs[w.c + 1] * s, e.ys[w.r] * s); ctx.lineTo(e.xs[w.c + 1] * s, e.ys[w.r + 1] * s); }
      else { ctx.moveTo(e.xs[w.c] * s, e.ys[w.r + 1] * s); ctx.lineTo(e.xs[w.c + 1] * s, e.ys[w.r + 1] * s); }
      ctx.stroke();
    }
  }
}

/** Fill the 3 x 5 result grid with the first n compartments. @param {Evaluation | null} res @param {number} n */
export function drawMatrix(res, n) {
  const m = $("matrix"); m.style.setProperty("--cols", String(COLS));
  if (m.children.length !== ROWS * COLS) {
    m.innerHTML = "";
    for (let i = 0; i < ROWS * COLS; i++) m.appendChild(document.createElement("div"));
  }
  [...m.children].forEach((d, i) => {
    const c = res && i < n ? res.cells[i] : null;
    d.className = c ? (c.flagged ? "bad" : c.dist ? "ok" : "") : "";
    d.textContent = c ? c.count : "";
  });
}

/** @param {Evaluation | null} res @param {boolean} done */
export function setVerdict(res, done) {
  const v = $("verdict");
  if (!done || !res) { v.className = "verdict"; v.innerHTML = `<div class="head">ANALYSING…</div>`; return; }
  v.className = "verdict " + (res.failed ? "fail" : "pass");
  v.innerHTML = `<div class="head">${res.failed ? "FAIL · DIVERT TO REJECT" : "PASS · CONTINUE"}</div>` +
    (res.findings.length ? `<ul>${res.findings.map((f) => `<li>${f}</li>`).join("")}</ul>`
                         : `<div style="font-size:.88rem;color:var(--muted)">All written rules satisfied.</div>`);
}

/** @param {string} key @param {"run" | "done" | "fail" | null} cls @param {number} [ms] */
export function setStep(key, cls, ms) {
  const li = document.querySelector(`#steps li[data-k="${key}"]`); if (!li) return;
  li.classList.remove("run", "done", "fail"); if (cls) li.classList.add(cls);
  const t = li.querySelector(".ms"); if (t) t.textContent = ms != null ? `${ms} ms` : "";
}

export function resetSteps() {
  document.querySelectorAll("#steps li").forEach((li) => {
    li.classList.remove("run", "done", "fail");
    const t = li.querySelector(".ms"); if (t) t.textContent = "";
  });
}
// @ts-check
// The production-line drawing: belts, clamping arms, tower light, diverter, and the boxes moving through it.
import { $ } from "./dom.js";
import { SCENE_W, BOX_W, BOX_H, BELT_Y, STATION_X, DIVERT_X, REJECT_PATH, GOOD_END, BELT_SPEED } from "./config.js";
import { state } from "./state.js";
import { boxImage } from "./data.js";
import { log, updateKpis } from "./log.js";
/** @typedef {import("../../types/model").Box} Box */
/** @typedef {import("../../types/model").BoxImage} BoxImage */
/** @typedef {import("../../types/model").Entry} Entry */

const scene = $("scene"), wrap = $("scene-wrap"), stage = $("stage");
/** @type {{ rod: HTMLElement, reach: number }[]} */ let arms = [];
/** @type {Box[]} */ let boxes = [];
let nextId = 0, beltOffset = 0, laneOffset = 0, last = performance.now();

function layout() {
  const fit = () => { scene.style.transform = `scale(${wrap.clientWidth / SCENE_W})`; };
  new ResizeObserver(fit).observe(wrap); fit();
  const fitStage = () => {                                  // 1600 x 900 stage, letterboxed into the window
    if (window.innerWidth <= 760) { stage.style.transform = "none"; return; }
    stage.style.transform = `translate(-50%, -50%) scale(${Math.min(window.innerWidth / 1600, window.innerHeight / 900)})`;
  };
  window.addEventListener("resize", fitStage); fitStage();

  const [a, b] = REJECT_PATH;                               // diagonal reject chute
  Object.assign($("belt-diag").style, {
    left: `${a[0]}px`, top: `${a[1] - 35}px`, width: `${Math.hypot(b[0] - a[0], b[1] - a[1]) + 40}px`,
    transform: `rotate(${Math.atan2(b[1] - a[1], b[0] - a[0])}rad)`,
  });

  const corners = [[STATION_X - BOX_W / 2, BELT_Y - BOX_H / 2], [STATION_X + BOX_W / 2, BELT_Y - BOX_H / 2],
                   [STATION_X - BOX_W / 2, BELT_Y + BOX_H / 2], [STATION_X + BOX_W / 2, BELT_Y + BOX_H / 2]];
  const anchors = [[312, 84], [528, 84], [312, 266], [528, 266]];
  arms = anchors.map(([ax, ay], i) => {                     // four hydraulic arms aimed at the box corners
    const [cx, cy] = corners[i];
    const el = document.createElement("div"); el.className = "arm";
    el.innerHTML = `<div class="cyl"></div><div class="rod"><div class="pad"></div></div>`;
    Object.assign(el.style, { left: `${ax}px`, top: `${ay - 7}px`, transform: `rotate(${Math.atan2(cy - ay, cx - ax)}rad)` });
    scene.appendChild(el);
    return { rod: /** @type {HTMLElement} */ (el.querySelector(".rod")), reach: Math.hypot(cx - ax, cy - ay) - 36 };
  });
}

/** Extend or retract the four clamping arms. @param {boolean} on */
export const clamp = (on) => arms.forEach((a) => { a.rod.style.width = on ? `${a.reach}px` : "6px"; });
/** Light one lamp of the tower light. @param {"t-r" | "t-a" | "t-g"} id */
export const tower = (id) => ["t-r", "t-a", "t-g"].forEach((t) => $(t).classList.toggle("on", t === id));
/** @param {boolean} on */
export function flash(on) { $("flash").classList.toggle("on", on); }

/** A data packet travelling between the camera and the AI pipeline node. @param {boolean} up camera → AI when true */
export function packet(up) {
  const p = $("packet"), from = up ? [420, 66] : [640, 28], to = up ? [640, 28] : [420, 66];
  p.style.transition = "none"; p.style.opacity = "1"; p.style.transform = `translate(${from[0]}px, ${from[1]}px)`;
  requestAnimationFrame(() => {
    p.style.transition = `transform ${0.35 / state.speed}s linear, opacity .2s`;
    p.style.transform = `translate(${to[0]}px, ${to[1]}px)`;
    setTimeout(() => { p.style.opacity = "0"; }, 380 / state.speed);
  });
}

function spawn() {
  if (!state.playlist.length) return;
  const k = state.pos++, entry = state.playlist[k % state.playlist.length];
  const el = document.createElement("div"); el.className = "box";
  el.innerHTML = `<canvas width="300" height="176"></canvas><div class="scan"></div><div class="stamp"></div>`;
  scene.insertBefore(el, $("flash"));
  /** @type {Box} */
  const b = { id: nextId++, entry, el, x: -BOX_W, y: BELT_Y, phase: "infeed", image: null, result: null, revealed: 0, dist: 0 };
  boxImage(entry).then((im) => {
    b.image = im;
    el.querySelector("canvas")?.getContext("2d")?.drawImage(im.canvas, 0, 0, 300, 176);
  });
  boxes.push(b);
  log(`box <b>#${b.id + 1}</b> enters infeed · ${entry.img_id}`);
}

/** @param {Box} b */
const place = (b) => { b.el.style.transform = `translate(${b.x - BOX_W / 2}px, ${b.y - BOX_H / 2}px)`; };

/** @type {{ image: BoxImage, onPlaced: (box: Box) => void } | null} */ let pendingUpload = null;

/** Place an uploaded photo at the camera as soon as the station is clear. @param {BoxImage} image @param {(box: Box) => void} onPlaced */
export function requestUploadPlacement(image, onPlaced) { pendingUpload = { image, onPlaced }; }
export function cancelUploadPlacement() { pendingUpload = null; }

function placeUpload() {
  if (!pendingUpload) return;
  const clear = !state.station && boxes.every((b) => b.phase !== "toDiverter" || b.x > STATION_X + BOX_W);
  if (!clear) return;
  const { image, onPlaced } = pendingUpload; pendingUpload = null;
  const el = document.createElement("div"); el.className = "box uploaded";
  el.innerHTML = `<canvas width="300" height="176"></canvas><div class="scan"></div><div class="stamp"></div>`;
  el.querySelector("canvas")?.getContext("2d")?.drawImage(image.canvas, 0, 0, 300, 176);
  scene.insertBefore(el, $("flash"));
  /** @type {Entry} placeholder until the GPU analysis arrives */
  const entry = { entry: "upload", img_id: "uploaded photo", label: null, color: "Uploaded", stops: 0,
                  rows: 3, cols: 5, xs: [], ys: [], grid_strength: 0, cells: [], walls: [] };
  /** @type {Box} */
  const b = { id: nextId++, entry, el, x: STATION_X, y: BELT_Y, phase: "station", image, result: null, revealed: 0, dist: 0, upload: true };
  boxes.push(b); place(b); state.station = b;
  log(`box <b>#${b.id + 1}</b> <span class="info">your photo is at Cam 01</span>`);
  onPlaced(b);
}

/** Point at distance d along a polyline, and whether its end was reached. @param {number[][]} path @param {number} d @returns {[number, number, boolean]} */
function along(path, d) {
  for (let i = 0; i < path.length - 1; i++) {
    const [x0, y0] = path[i], [x1, y1] = path[i + 1], L = Math.hypot(x1 - x0, y1 - y0);
    if (d <= L) return [x0 + (x1 - x0) * d / L, y0 + (y1 - y0) * d / L, false];
    d -= L;
  }
  const e = path[path.length - 1]; return [e[0], e[1], true];
}

/** @param {Box} b */
function divert(b) {
  if (b.result?.failed) {
    b.phase = "reject"; b.dist = 0;
    $("gate").classList.add("active"); setTimeout(() => $("gate").classList.remove("active"), 650 / state.speed);
    log(`box <b>#${b.id + 1}</b> <span class="bad">diverted to reject lane</span>`);
  } else {
    b.phase = "good"; log(`box <b>#${b.id + 1}</b> <span class="ok">continues to good lane</span>`);
  }
}

/**
 * Start the line.
 * @param {(box: Box) => void} onArrive called when a box reaches the camera; it must set box.phase = "toDiverter" when done
 */
export function startLine(onArrive) {
  layout();
  /** @param {number} now */
  const tick = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (state.running) {
      state.runMs += dt * 1000;
      const v = BELT_SPEED * state.speed * dt, mainMoving = !state.station && !state.hold;
      if (mainMoving) beltOffset += v;
      laneOffset += v;
      $("belt-main").style.backgroundPosition = `${beltOffset}px 0`;
      ["belt-good", "belt-rej", "belt-diag"].forEach((id) => { $(id).style.backgroundPosition = `${laneOffset}px 0`; });
      if (mainMoving) {                                    // infeed waits while the station is busy or held
        for (const b of boxes.filter((x) => x.phase === "infeed")) {
          if (b.x + v >= STATION_X) { b.x = STATION_X; place(b); onArrive(b); break; }
          b.x += v;
        }
      }
      for (const b of boxes.filter((x) => x.phase === "toDiverter")) {   // inspected boxes always move on
        b.x += v;
        if (b.x >= DIVERT_X) divert(b);
      }
      placeUpload();
      for (const b of boxes) {
        if (b.phase === "good") {
          b.x += v;
          if (b.x >= GOOD_END) { b.phase = "done"; state.binGood++; b.el.classList.add("gone"); updateKpis(); }
        } else if (b.phase === "reject") {
          b.dist += v; const [x, y, end] = along(REJECT_PATH, b.dist); b.x = x; b.y = y;
          if (end) { b.phase = "done"; state.binRej++; b.el.classList.add("gone"); updateKpis(); }
        }
        if (b.phase !== "done") place(b);
      }
      boxes.filter((b) => b.phase === "done" && !b.removing).forEach((b) => { b.removing = true; setTimeout(() => b.el.remove(), 500); });
      boxes = boxes.filter((b) => !(b.phase === "done" && b.removing && !b.el.isConnected));
      const infeed = boxes.filter((b) => b.phase === "infeed"), lastBox = infeed[infeed.length - 1];
      if (mainMoving && infeed.length < 2 && (!lastBox || lastBox.x > -BOX_W / 2 + 200)) spawn();
      if (state.inspected && Math.floor(now / 1000) !== Math.floor((now - dt * 1000) / 1000)) updateKpis();
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

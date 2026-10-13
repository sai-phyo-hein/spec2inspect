// @ts-check
// Pin colour per compartment, measured from pixels: pins are the only strongly coloured objects in the box.
/** @typedef {import("../../types/model").Entry} Entry */
/** @typedef {import("../../types/model").BoxImage} BoxImage */

/** Name of a hue angle in degrees. @param {number} h @returns {string} */
export const hueName = (h) => h < 15 || h >= 345 ? "red" : h < 25 ? "orange" : h < 70 ? "yellow" : h < 160 ? "green"
                           : h < 200 ? "cyan" : h < 255 ? "blue" : h < 308 ? "purple" : "pink";

/**
 * Dominant pin colour in each compartment, or null where no coloured object is found.
 * @param {BoxImage} image box photo; image.w/h are the original pixel size the cell boxes refer to
 * @param {Entry} entry
 * @returns {(string | null)[]}
 */
export function cellColours(image, entry) {
  const s = image.canvas.width / image.w, g = image.canvas.getContext("2d");
  if (!g) return entry.cells.map(() => null);
  return entry.cells.map((c) => {
    const [x0, y0, x1, y1] = c.box.map((v) => Math.round(v * s)), w = x1 - x0, h = y1 - y0;
    if (w <= 0 || h <= 0) return null;
    const d = g.getImageData(x0, y0, w, h).data;
    /** @type {Record<string, number>} */ const tally = {};
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], gg = d[i + 1], b = d[i + 2], mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
      if (mx <= 35 || (mx - mn) / mx <= 0.43) continue;
      const dd = mx - mn;
      const hh = mx === r ? ((((gg - b) / dd) % 6) + 6) % 6 : mx === gg ? (b - r) / dd + 2 : (r - gg) / dd + 4;
      const name = hueName(hh * 60);
      tally[name] = (tally[name] || 0) + 1; n++;
    }
    if (n < 0.003 * w * h) return null;
    return Object.entries(tally).sort((a, b) => b[1] - a[1])[0][0];
  });
}

// @ts-check
// Typed element lookups. Each throws if the element is missing, so a broken page fails loudly at start-up.

/** @param {string} id @returns {HTMLElement} */
export function $(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el;
}
/** @param {string} id */ export const $input = (id) => /** @type {HTMLInputElement} */ ($(id));
/** @param {string} id */ export const $select = (id) => /** @type {HTMLSelectElement} */ ($(id));
/** @param {string} id */ export const $button = (id) => /** @type {HTMLButtonElement} */ ($(id));
/** @param {string} id */ export const $canvas = (id) => /** @type {HTMLCanvasElement} */ ($(id));

// @ts-check
// The start-up overlay: it is in the HTML, so it shows from the first paint; these functions report progress and
// remove it once the station is ready. After a few seconds it explains a cold start, so a slow first visit never
// looks like a frozen or broken page.
const el = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
const hintTimer = setTimeout(() => { el("boot-hint").hidden = false; }, 6000);

/** @param {string} text */
export function bootStep(text) { el("boot-step").textContent = text; }

export function bootDone() {
  clearTimeout(hintTimer);
  el("boot").classList.add("done");
  el("boot").setAttribute("aria-busy", "false");
}

/** @param {string} message */
export function bootFail(message) {
  clearTimeout(hintTimer);
  el("boot").classList.add("failed");
  const title = el("boot").querySelector(".boot-title");
  if (title) title.textContent = "The station could not start";
  bootStep(message);
  el("boot-hint").hidden = false;
  el("boot-hint").textContent = "The server may still be starting. Try again in a moment.";
  const retry = el("boot-retry"); retry.hidden = false;
  retry.addEventListener("click", () => location.reload());
}

/** Wait for an image to load (or fail), at most `ms`. @param {string} url @param {number} ms */
export function preload(url, ms) {
  return new Promise((resolve) => {
    const img = new Image(); const t = setTimeout(resolve, ms);
    img.onload = img.onerror = () => { clearTimeout(t); resolve(undefined); };
    img.src = url;
  });
}

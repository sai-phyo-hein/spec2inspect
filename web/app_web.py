"""Spec-to-Inspection web page (Cloud Run, CPU only).

"/" serves the line page from public/ (HTML, CSS and JS modules); "/inspect" is the Gradio page. Slideshow and browsing replay Gemma 4 answers recorded on Kaggle; the rules (pins per compartment, threshold,
wall check) are re-applied live to the recorded answer distributions. Only "Run live" on an uploaded photo calls
the model, on a GPU service (or API) that scales to zero when unused.
"""
import os, json, time, random, threading
from urllib.parse import urlparse
import numpy as np, requests
import gradio as gr
from PIL import Image
from spec_core import (CELL_TEXT, DIGITS, ROWS, COLS, COLOR_MODES, analyze, render, recolor, expose,
                       chat_body, answer_distribution)

REPLAY_DIR    = os.environ.get("REPLAY_DIR", "/app/replay")
PORT          = int(os.environ.get("PORT", "8080"))
INFER_ENDPOINT = os.environ.get("INFER_ENDPOINT", "")           # e.g. https://<gpu-service>.run.app/v1/chat/completions
INFER_AUTH    = os.environ.get("INFER_AUTH", "google")           # google | key | none
INFER_API_KEY = os.environ.get("INFER_API_KEY", "")
INFER_MODEL   = os.environ.get("INFER_MODEL", "gemma")
AUTOPLAY_MAX_MIN = float(os.environ.get("AUTOPLAY_MAX_MIN", "30"))

# ---------------- recorded replay ----------------
INDEX = json.load(open(os.path.join(REPLAY_DIR, "index.json")))
ENTRIES = {e["entry"]: e for e in INDEX["entries"]}
img_path = lambda eid: os.path.join(REPLAY_DIR, "images", f"{eid}.jpg")
IMAGES = sorted({e["img_id"] for e in ENTRIES.values()})
LABEL = {e["img_id"]: e["label"] for e in ENTRIES.values()}
VARIANTS = sorted({(e["color"], e["stops"]) for e in ENTRIES.values()}, key=lambda v: (v[1] != 0, v[0] != "Original", v))
def variant_name(v):
    colour = "mixed-colour" if v[0] == "Random per pin" else ("original yellow" if v[0] == "Original" else v[0].lower())
    light = "normal light" if v[1] == 0 else ("darker, " if v[1] < 0 else "brighter, ") + f"{v[1]:+.1f} stops"
    return f"{colour} pins, {light}"
VARIANT_BY_NAME = {variant_name(v): v for v in VARIANTS}
def find_entry(img_id, v):
    return next((e for e in ENTRIES.values() if e["img_id"] == img_id and (e["color"], e["stops"]) == tuple(v)), None)

# Slideshow order: alternate good and anomalous boxes, a different variant each time, missing-wall example second.
_rng = random.Random(7)
_good = [i for i in IMAGES if LABEL[i] == 0]; _bad = [i for i in IMAGES if LABEL[i] == 1]
_rng.shuffle(_good); _rng.shuffle(_bad)
_order = [x for pair in zip(_good, _bad) for x in pair] + _good[len(_bad):] + _bad[len(_good):]
if "logi_067" in _order:
    _order.remove("logi_067"); _order.insert(1, "logi_067")
PLAYLIST = []
for k, i in enumerate(_order):
    e = find_entry(i, VARIANTS[k % len(VARIANTS)]) or next(x for x in ENTRIES.values() if x["img_id"] == i)
    PLAYLIST.append(e["entry"])
STATE = {"pos": 0, "seen": 0, "agree": 0, "flagged": 0}
LOCK = threading.Lock()

def show_entry(eid, expected, threshold, check_walls):
    e = ENTRIES[eid]
    out, verdict, table, failed = render(Image.open(img_path(eid)), e, expected, threshold, check_walls)
    with LOCK:
        STATE["seen"] += 1; STATE["flagged"] += int(failed); STATE["agree"] += int(failed == (e["label"] == 1))
        t = dict(STATE)
    truth = "good" if e["label"] == 0 else "logical anomaly"
    tally = (f"Image **{e['img_id']}** ({variant_name((e['color'], e['stops']))}; ground truth: {truth}) → "
             f"{'FAIL' if failed else 'PASS'}  \n**Inspected {t['seen']}** | flagged {t['flagged']} | "
             f"agrees with ground truth on {t['agree']}/{t['seen']}  \n"
             f"_Replaying Gemma 4 E4B answers recorded on Kaggle ({INDEX.get('recorded', '')[:10]}); "
             f"rules re-applied live._")
    return out, verdict, table, tally

def autoplay(expected, threshold, check_walls, dwell):
    t_end = time.time() + AUTOPLAY_MAX_MIN * 60
    while time.time() < t_end:
        pos = STATE["pos"] % len(PLAYLIST); STATE["pos"] = pos + 1
        out, verdict, table, tally = show_entry(PLAYLIST[pos], expected, threshold, check_walls)
        yield out, verdict, table, tally, gr.update(selected_index=pos)
        time.sleep(float(dwell))
    yield gr.update(), gr.update(), gr.update(), f"Slideshow paused after {AUTOPLAY_MAX_MIN:.0f} minutes. Press Play to continue.", gr.update()

def pick_thumb(expected, threshold, check_walls, evt: gr.SelectData):
    STATE["pos"] = evt.index + 1
    return show_entry(PLAYLIST[evt.index], expected, threshold, check_walls)

def pick_variant(img_id, vname, expected, threshold, check_walls):
    e = find_entry(img_id, VARIANT_BY_NAME[vname])
    if e is None:
        return None, "That combination was not recorded.", None, ""
    return show_entry(e["entry"], expected, threshold, check_walls)

def reset_tally():
    with LOCK:
        STATE.update(seen=0, agree=0, flagged=0)
    return "Tally reset."

# ---------------- live inspection of an upload (calls the model) ----------------
_tok = {"value": None, "exp": 0}
def auth_headers():
    if INFER_AUTH == "key" and INFER_API_KEY:
        return {"Authorization": f"Bearer {INFER_API_KEY}"}
    if INFER_AUTH == "google":
        if time.time() > _tok["exp"]:
            u = urlparse(INFER_ENDPOINT); aud = f"{u.scheme}://{u.netloc}"
            r = requests.get("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity",
                             params={"audience": aud}, headers={"Metadata-Flavor": "Google"}, timeout=5)
            r.raise_for_status(); _tok.update(value=r.text, exp=time.time() + 45 * 60)
        return {"Authorization": f"Bearer {_tok['value']}"}
    return {}

def ask_remote(crop, text, answers, deadline):
    while True:                                   # the GPU service may be cold: retry while it starts
        try:
            r = requests.post(INFER_ENDPOINT, json=chat_body(crop, text, INFER_MODEL), headers=auth_headers(), timeout=120)
            if r.status_code in (429, 500, 502, 503, 504):
                raise RuntimeError(f"HTTP {r.status_code}")
            r.raise_for_status()
            return answer_distribution(r.json()["choices"][0], answers)
        except Exception:
            if time.time() > deadline:
                raise
            time.sleep(5)

LIVE = threading.Semaphore(1)
def run_live(upload, color_mode, stops, cell_text, expected, threshold, check_walls):
    if not INFER_ENDPOINT:
        yield None, "Live inspection is not configured on this deployment.", None, ""; return
    if upload is None:
        yield None, "Upload a photo of a box first.", None, ""; return
    if not LIVE.acquire(blocking=False):
        yield None, "Another live inspection is running. Try again in a moment.", None, ""; return
    try:
        yield None, "Running live on Gemma 4. If the GPU was idle it starts first, which can take 1-2 minutes...", None, ""
        im = expose(recolor(upload.convert("RGB"), color_mode, seed=int(time.time())), float(stops))
        t0 = time.time(); deadline = t0 + 300
        raw = analyze(im, lambda c, t, a: ask_remote(c, t, a, deadline), cell_text=cell_text, max_workers=4)
        out, verdict, table, failed = render(im, raw, expected, threshold, check_walls)
        yield out, verdict + f"\n\n_Live run: 15 model checks + 22 wall measurements in {time.time()-t0:.1f} s._", table, \
              "Uploaded photo, inspected live (no ground truth)."
    except Exception as ex:
        yield None, f"Live inspection failed: {type(ex).__name__}: {ex}", None, ""
    finally:
        LIVE.release()

# ---------------- page ----------------
with gr.Blocks(title="Spec-to-Inspection") as demo:
    gr.Markdown("# Spec-to-Inspection\nWritten rules in, located verdict out. **No training images.** "
                "Gemma 4 E4B counts the pushpins in each compartment; a geometric check measures the walls. "
                "Pin colour and lighting are synthetic edits that test robustness.")
    with gr.Row():
        play = gr.Button("▶ Play", variant="primary"); stop = gr.Button("⏸ Stop")
        dwell = gr.Slider(0, 10, value=3, step=0.5, label="Seconds per image")
    gallery = gr.Gallery(value=[(img_path(e), ENTRIES[e]["img_id"]) for e in PLAYLIST], columns=12, rows=1,
                         height=150, allow_preview=False, label="Recorded images: click one to inspect it")
    with gr.Row():
        with gr.Column(scale=3):
            out_img = gr.Image(label="Red = rule broken (with the model's count), green = OK, orange = missing wall")
            tally = gr.Markdown()
            verdict = gr.Markdown()
        with gr.Column(scale=2):
            gr.Markdown("### The written specification")
            with gr.Row():
                expected = gr.Number(value=1, label="Pins per compartment (rule 1)", precision=0)
                threshold = gr.Slider(0.05, 0.95, value=0.5, step=0.05, label="Flag when P(violation) exceeds")
            check_walls = gr.Checkbox(value=True, label="Rule 3: every compartment is enclosed by walls")
            with gr.Accordion("Browse a recorded image and variant", open=False):
                pick_img = gr.Dropdown(IMAGES, value=IMAGES[0], label="Image")
                pick_var = gr.Dropdown(list(VARIANT_BY_NAME), value=list(VARIANT_BY_NAME)[0], label="Colour and lighting")
                show_btn = gr.Button("Show")
            with gr.Accordion("Run live on your own photo (uses the GPU)", open=False):
                upload = gr.Image(type="pil", label="Photo of a 3 x 5 compartment box")
                color_mode = gr.Dropdown([m for m in COLOR_MODES if not m.startswith("Cycle")], value="Original",
                                         label="Pin colour (synthetic edit)")
                stops = gr.Slider(-2.5, 1.5, value=0, step=0.25, label="Lighting (stops)")
                cell_text = gr.Textbox(value=INDEX.get("cell_text", CELL_TEXT), lines=4,
                                       label="Question the model asks about each compartment")
                live_btn = gr.Button("Run live", variant="primary")
            reset = gr.Button("Reset tally", size="sm")
            table = gr.Dataframe(label="Every check", wrap=True)

    rules = [expected, threshold, check_walls]
    outs = [out_img, verdict, table, tally]
    play_evt = play.click(autoplay, rules + [dwell], outs + [gallery])
    stop.click(None, None, None, cancels=[play_evt])
    gallery.select(pick_thumb, rules, outs, cancels=[play_evt])
    show_btn.click(pick_variant, [pick_img, pick_var] + rules, outs, cancels=[play_evt])
    live_btn.click(run_live, [upload, color_mode, stops, cell_text] + rules, outs, cancels=[play_evt])
    reset.click(reset_tally, None, tally)

if __name__ == "__main__":
    # "/" = line page (public/), "/replay" = recorded results, "/api/live/*" = live inspection, "/inspect" = Gradio page
    import uvicorn
    from fastapi import FastAPI
    from fastapi.staticfiles import StaticFiles
    from fastapi import Body, HTTPException
    app = FastAPI()
    app.mount("/replay", StaticFiles(directory=REPLAY_DIR), name="replay")
    LIVE_SLOTS = threading.Semaphore(2)            # at most two boxes analysed on the GPU at once

    @app.get("/api/live/status")
    def live_status():
        return {"available": bool(INFER_ENDPOINT)}

    @app.post("/api/live/warm")
    def live_warm():
        """Wake the GPU service (scaled to zero when idle) and wait until the model is loaded."""
        if not INFER_ENDPOINT:
            raise HTTPException(503, "live mode is not configured")
        u = urlparse(INFER_ENDPOINT); base = f"{u.scheme}://{u.netloc}"
        t0 = time.time()
        while time.time() - t0 < 300:
            try:
                if requests.get(f"{base}/health", headers=auth_headers(), timeout=60).status_code == 200:
                    return {"ready": True, "seconds": round(time.time() - t0, 1)}
            except Exception:
                pass
            time.sleep(5)
        return {"ready": False, "seconds": round(time.time() - t0, 1)}

    @app.post("/api/live/inspect")
    def live_inspect(payload: dict = Body(...)):
        """Analyse one recorded box image now: grid + walls on CPU, 15 compartment checks on the GPU."""
        eid = payload.get("entry")
        if not INFER_ENDPOINT:
            raise HTTPException(503, "live mode is not configured")
        if eid not in ENTRIES:
            raise HTTPException(404, "unknown image")
        if not LIVE_SLOTS.acquire(timeout=120):
            raise HTTPException(429, "GPU busy")
        try:
            im = Image.open(img_path(eid)).convert("RGB")
            t0 = time.time(); deadline = t0 + 300
            raw = analyze(im, lambda c, t, a: ask_remote(c, t, a, deadline),
                          cell_text=INDEX.get("cell_text", CELL_TEXT), max_workers=4)
            e = ENTRIES[eid]
            raw.update(entry=eid, img_id=e["img_id"], label=e["label"], color=e["color"], stops=e["stops"],
                       seconds=round(time.time() - t0, 2), live=True)
            return raw
        finally:
            LIVE_SLOTS.release()
    demo.queue(default_concurrency_limit=8)
    app = gr.mount_gradio_app(app, demo, path="/inspect")
    # The line page itself: static HTML/CSS/JS modules from public/ (the same folder Firebase Hosting serves).
    PUBLIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public")
    app.mount("/", StaticFiles(directory=PUBLIC_DIR, html=True), name="line-page")
    uvicorn.run(app, host="0.0.0.0", port=PORT)

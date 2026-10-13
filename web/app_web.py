"""spec2inspect web service (Cloud Run, CPU only).

/              the line page (public/: HTML, CSS, JS modules), the same files Firebase Hosting serves
/replay/...    recorded results (index.json + images), mounted read-only from Cloud Storage
/api/live/...  Live mode: inspect an uploaded photo now, with Gemma 4 on the private GPU service
/api/samples   sample photos for the Live tray, proxied from a public Hugging Face dataset (same origin, so the page
               can read their pixels)

Uploaded-photo inspection runs as a short job the page polls, so no single request has to wait for the GPU to
start (Firebase Hosting gives requests to Cloud Run about a minute).
"""
import base64, binascii, io, os, threading, time, uuid
from urllib.parse import urlparse

import requests
import uvicorn
from fastapi import FastAPI, HTTPException, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel

from spec_core import CELL_TEXT, analyze, answer_distribution, chat_body

REPLAY_DIR     = os.environ.get("REPLAY_DIR", "/app/replay")
PUBLIC_DIR     = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public")
PORT           = int(os.environ.get("PORT", "8080"))
INFER_ENDPOINT = os.environ.get("INFER_ENDPOINT", "")      # https://<spec-gpu>.run.app/v1/chat/completions
INFER_AUTH     = os.environ.get("INFER_AUTH", "google")      # google | key | none
INFER_API_KEY  = os.environ.get("INFER_API_KEY", "")
INFER_MODEL    = os.environ.get("INFER_MODEL", "gemma")
MAX_UPLOAD_MB  = 8
JOB_TTL_S      = 15 * 60
GPU_DEADLINE_S = 360                                         # covers a GPU cold start plus the 15 checks
SAMPLES_REPO   = os.environ.get("SAMPLES_REPO", "saiphyohein/spec2inspect-images")
MAX_SAMPLES    = 24

app = FastAPI(title="spec2inspect", docs_url=None, redoc_url=None)


# ---------------- calling the GPU service ----------------
_token = {"value": None, "exp": 0.0}

def auth_headers() -> dict:
    """Identity token for the private GPU service (Cloud Run service-to-service), or an API key."""
    if INFER_AUTH == "key" and INFER_API_KEY:
        return {"Authorization": f"Bearer {INFER_API_KEY}"}
    if INFER_AUTH == "google":
        if time.time() > _token["exp"]:
            u = urlparse(INFER_ENDPOINT)
            r = requests.get("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity",
                             params={"audience": f"{u.scheme}://{u.netloc}"}, headers={"Metadata-Flavor": "Google"}, timeout=5)
            r.raise_for_status()
            _token.update(value=r.text, exp=time.time() + 45 * 60)
        return {"Authorization": f"Bearer {_token['value']}"}
    return {}

def ask_remote(crop, text, answers, deadline):
    """One compartment question. Retries while the GPU service is starting (it scales to zero when idle)."""
    while True:
        try:
            r = requests.post(INFER_ENDPOINT, json=chat_body(crop, text, INFER_MODEL), headers=auth_headers(), timeout=120)
            if r.status_code in (429, 500, 502, 503, 504):
                raise RuntimeError(f"GPU service HTTP {r.status_code}")
            r.raise_for_status()
            return answer_distribution(r.json()["choices"][0], answers)
        except Exception:
            if time.time() > deadline:
                raise
            time.sleep(5)


# ---------------- upload inspection jobs ----------------
JOBS: dict = {}
JOBS_LOCK = threading.Lock()
GPU_SLOT = threading.Semaphore(1)            # one uploaded photo on the GPU at a time

class UploadJob(BaseModel):
    image: str                                # data URL or bare base64 of a JPEG/PNG photo

def decode_image(data: str) -> Image.Image:
    raw = data.split(",", 1)[1] if data.startswith("data:") else data
    if len(raw) * 3 / 4 > MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(413, f"image larger than {MAX_UPLOAD_MB} MB")
    try:
        im = Image.open(io.BytesIO(base64.b64decode(raw, validate=True)))
        im.load()
    except (binascii.Error, UnidentifiedImageError, OSError):
        raise HTTPException(400, "not a readable image")
    return im.convert("RGB")

def run_job(job_id: str, im: Image.Image):
    job = JOBS[job_id]
    with GPU_SLOT:
        job.update(state="running", started=time.time())
        try:
            t0 = time.time()
            deadline = t0 + GPU_DEADLINE_S
            raw = analyze(im, lambda c, t, a: ask_remote(c, t, a, deadline), cell_text=CELL_TEXT, max_workers=4)
            raw.update(entry=f"upload-{job_id}", img_id="uploaded photo", label=None, color="Uploaded", stops=0.0,
                       w=im.width, h=im.height, seconds=round(time.time() - t0, 2), live=True)
            job.update(state="done", result=raw)
        except Exception as ex:                # reported to the page, which shows it in the line log
            job.update(state="error", error=f"{type(ex).__name__}: {ex}")
        job["finished"] = time.time()

def prune_jobs():
    now = time.time()
    with JOBS_LOCK:
        for k in [k for k, j in JOBS.items() if now - j["created"] > JOB_TTL_S]:
            JOBS.pop(k, None)


@app.get("/api/live/status")
def live_status():
    return {"available": bool(INFER_ENDPOINT)}

@app.post("/api/live/jobs")
def create_job(body: UploadJob):
    if not INFER_ENDPOINT:
        raise HTTPException(503, "live inspection is not configured on this deployment")
    im = decode_image(body.image)
    prune_jobs()
    job_id = uuid.uuid4().hex[:12]
    with JOBS_LOCK:
        JOBS[job_id] = {"state": "queued", "created": time.time()}
    threading.Thread(target=run_job, args=(job_id, im), daemon=True).start()
    return {"id": job_id}

@app.get("/api/live/jobs/{job_id}")
def get_job(job_id: str):
    job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "unknown or expired job")
    out = {"state": job["state"], "elapsed": round(time.time() - job["created"], 1)}
    if job["state"] == "done":
        out["result"] = job["result"]
    if job["state"] == "error":
        out["error"] = job["error"]
    return out


# ---------------- sample photos for the Live tray ----------------
_samples = {"items": None, "at": 0.0}
_sample_bytes: dict = {}
IMAGE_TYPES = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png"}

def list_samples() -> list:
    """Image files in the public Hugging Face dataset (cached for 10 minutes). Empty if it can't be reached."""
    if _samples["items"] is not None and time.time() - _samples["at"] < 600:
        return _samples["items"]
    items = []
    try:
        r = requests.get(f"https://huggingface.co/api/datasets/{SAMPLES_REPO}/tree/main", params={"recursive": "true"}, timeout=10)
        r.raise_for_status()
        paths = sorted(f["path"] for f in r.json() if f.get("type") == "file" and os.path.splitext(f["path"])[1].lower() in IMAGE_TYPES)
        items = [{"name": os.path.basename(p), "url": f"api/samples/file/{p}"} for p in paths[:MAX_SAMPLES]]
    except Exception:
        items = []                                # the page falls back to recorded boxes
    _samples.update(items=items, at=time.time())
    return items

@app.get("/api/samples")
def samples():
    return {"source": SAMPLES_REPO, "items": list_samples()}

@app.get("/api/samples/file/{path:path}")
def sample_file(path: str):
    if path not in {i["url"].split("api/samples/file/", 1)[1] for i in list_samples()}:
        raise HTTPException(404, "not a sample photo")
    if path not in _sample_bytes:
        r = requests.get(f"https://huggingface.co/datasets/{SAMPLES_REPO}/resolve/main/{path}", timeout=30)
        if r.status_code != 200:
            raise HTTPException(502, "could not fetch the sample photo")
        _sample_bytes[path] = r.content
    media = IMAGE_TYPES.get(os.path.splitext(path)[1].lower(), "application/octet-stream")
    return Response(_sample_bytes[path], media_type=media, headers={"Cache-Control": "public, max-age=3600"})


# ---------------- static files: recorded results and the line page ----------------
app.mount("/replay", StaticFiles(directory=REPLAY_DIR), name="replay")
app.mount("/", StaticFiles(directory=PUBLIC_DIR, html=True), name="line-page")

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=PORT)

"""spec2inspect web service (Cloud Run, CPU only).

/              the line page (public/: HTML, CSS, JS modules), the same files Firebase Hosting serves
/replay/...    recorded results (index.json + images), mounted read-only from Cloud Storage
/api/live/...  Live mode: inspect an uploaded photo now, with Gemma 4 on the private GPU service
/api/samples   sample photos for the Live tray, proxied from a public Hugging Face dataset (same origin, so the page
               can read their pixels)
/api/checks    the shared inspection log: every photo inspected live, stored in Firestore (read by the Check page)
/api/spec      the approved specification (region plan + rules), versioned in Firestore; written by the Admin page
/api/regions   region preview for the Admin page: divides a sample photo into regions and measures walls (CPU only)
/api/plan      the Inspection Planner: Gemini (Vertex AI) turns the written spec + a sample image into a region program
               and rules (structured JSON), validated here before the page shows them

Uploaded-photo inspection runs as a short job the page polls, so no single request has to wait for the GPU to
start (Firebase Hosting gives requests to Cloud Run about a minute).
"""
import base64, binascii, io, json, os, threading, time, uuid
from urllib.parse import urlparse

import requests
import uvicorn
from fastapi import FastAPI, Header, HTTPException, Response
from typing import Literal, Optional, Union
from fastapi.staticfiles import StaticFiles
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, Field

from spec_core import CELL_TEXT, DEFAULT_PROGRAM, analyze, answer_distribution, chat_body, run_region_program

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
GPU_PARALLEL   = int(os.environ.get("GPU_PARALLEL", "16"))     # compartment questions in flight; match spec-gpu slots
SAMPLES_REPO   = os.environ.get("SAMPLES_REPO", "saiphyohein/spec2inspect-images")
CHECKS_STORE   = os.environ.get("CHECKS_STORE", "memory")      # "firestore" on Cloud Run; "memory" for local runs
CHECKS_COLL    = os.environ.get("CHECKS_COLLECTION", "inspections")
SPECS_COLL     = os.environ.get("SPECS_COLLECTION", "specs")
ADMIN_TOKEN    = os.environ.get("ADMIN_TOKEN", "")               # if set, approving (and planning) needs this token
PROJECT_ID     = os.environ.get("GOOGLE_CLOUD_PROJECT", "")
PLANNER_MODELS = [m.strip() for m in os.environ.get("PLANNER_MODELS", "gemini-3.5-pro").split(",") if m.strip()]
PLANNER_LOC    = os.environ.get("PLANNER_LOCATION", "global")     # Gemini 3.x on Vertex AI: the global endpoint
PLANS_PER_MIN  = int(os.environ.get("PLANS_PER_MINUTE", "6"))     # cost guard for the public page
MAX_SAMPLES    = 40                                           # tray photos listed from the dataset

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

# ---------------- region programs (validated before they are run) ----------------
class StepNormalize(BaseModel):
    op: Literal["normalize_light"]

class StepGrid(BaseModel):
    op: Literal["grid_from_walls"]
    rows: Union[Literal["auto"], int] = "auto"
    cols: Union[Literal["auto"], int] = "auto"
    inset: int = Field(6, ge=0, le=40)
    max_cells: int = Field(8, ge=2, le=12)

class FixedRegion(BaseModel):
    id: Optional[str] = Field(None, max_length=40)
    box: list[float] = Field(min_length=4, max_length=4)   # x0, y0, x1, y1 as fractions of the photo
    row: int = Field(0, ge=0, le=11)
    col: Optional[int] = Field(None, ge=0, le=11)

class StepFixed(BaseModel):
    op: Literal["fixed_regions"]
    regions: list[FixedRegion] = Field(min_length=1, max_length=40)

class StepWalls(BaseModel):
    op: Literal["wall_segments"]
    missing_below: float = Field(0.30, ge=0.0, le=1.0)

class RegionProgram(BaseModel):
    """What the planner outputs and the line executes: an ordered list of region operations."""
    program: Literal["region-plan/v1"] = "region-plan/v1"
    steps: list[Union[StepNormalize, StepGrid, StepFixed, StepWalls]] = Field(min_length=1, max_length=10)

    def as_dict(self):
        d = self.model_dump(exclude_none=True)
        for st in d["steps"]:                        # grid sizes must be 1-8 when not "auto"
            for k in ("rows", "cols"):
                if isinstance(st.get(k), int) and not 1 <= st[k] <= 8:
                    raise HTTPException(422, f"{k} must be 'auto' or 1-8")
            if st["op"] == "fixed_regions":
                for g in st["regions"]:
                    x0, y0, x1, y1 = g["box"]
                    if not (0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1):
                        raise HTTPException(422, "fixed region boxes must be fractions with x0 < x1 and y0 < y1")
        return d

class UploadJob(BaseModel):
    image: str                                # data URL or bare base64 of a JPEG/PNG photo
    program: Optional[RegionProgram] = None   # the approved region program (default if omitted)

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

def run_job(job_id: str, im: Image.Image, program: Optional[dict] = None):
    job = JOBS[job_id]
    with GPU_SLOT:
        job.update(state="running", started=time.time())
        try:
            t0 = time.time()
            deadline = t0 + GPU_DEADLINE_S
            raw = analyze(im, lambda c, t, a: ask_remote(c, t, a, deadline), cell_text=CELL_TEXT,
                          program=program or DEFAULT_PROGRAM, max_workers=GPU_PARALLEL)
            raw.update(entry=f"upload-{job_id}", img_id="uploaded photo", label=None, color="Uploaded", stops=0.0,
                       w=im.width, h=im.height, seconds=round(time.time() - t0, 2), live=True,
                       queued_s=round(t0 - job["created"], 2))
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

_warm = {"at": 0.0}

def _ping_gpu():
    """Wake the GPU service in the background (it scales to zero), so it is ready by the time Inspect is pressed."""
    u = urlparse(INFER_ENDPOINT)
    deadline = time.time() + GPU_DEADLINE_S
    while time.time() < deadline:
        try:
            if requests.get(f"{u.scheme}://{u.netloc}/health", headers=auth_headers(), timeout=30).status_code == 200:
                return
        except Exception:
            pass
        time.sleep(5)

@app.post("/api/live/warm")
def warm():
    """Called when the page switches to Live. Returns at once; the GPU starts in the background."""
    if INFER_ENDPOINT and time.time() - _warm["at"] > 60:
        _warm["at"] = time.time()
        threading.Thread(target=_ping_gpu, daemon=True).start()
    return {"ok": True}

@app.post("/api/live/jobs")
def create_job(body: UploadJob):
    if not INFER_ENDPOINT:
        raise HTTPException(503, "live inspection is not configured on this deployment")
    im = decode_image(body.image)
    prune_jobs()
    job_id = uuid.uuid4().hex[:12]
    with JOBS_LOCK:
        JOBS[job_id] = {"state": "queued", "created": time.time()}
    program = body.program.as_dict() if body.program else None
    threading.Thread(target=run_job, args=(job_id, im, program), daemon=True).start()
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


# ---------------- inspection log (Firestore) ----------------

class CheckRecord(BaseModel):
    """One live inspection, as shown on the Check page. Sizes are capped so the public endpoint can't be abused."""
    id: str = Field(max_length=64)
    at: str = Field(max_length=40)
    name: str = Field(max_length=200)
    thumb: str = Field(max_length=300_000)              # small JPEG data URL with the inspection overlay
    failed: bool
    findings: list[str] = Field(max_length=60)
    counts: list[str] = Field(max_length=30)
    seconds: float | None = None
    rules: list[str] = Field(max_length=40)
    spec_version: Optional[int] = None

class MemoryStore:
    """Local runs and tests: the log lives in this process."""
    def __init__(self): self.items, self.lock = [], threading.Lock()
    def add(self, rec: dict):
        with self.lock: self.items.insert(0, rec); del self.items[500:]
    def latest(self, limit: int) -> list:
        with self.lock: return self.items[:limit]

class FirestoreStore:
    """Cloud Run: one document per inspection in the `inspections` collection, newest first by `at`."""
    def __init__(self, collection: str):
        from google.cloud import firestore
        self.db, self.coll, self.firestore = firestore.Client(), collection, firestore
    def add(self, rec: dict):
        self.db.collection(self.coll).document(rec["id"]).set({**rec, "stored": self.firestore.SERVER_TIMESTAMP})
    def latest(self, limit: int) -> list:
        q = self.db.collection(self.coll).order_by("at", direction=self.firestore.Query.DESCENDING).limit(limit)
        return [{k: v for k, v in d.to_dict().items() if k != "stored"} for d in q.stream()]

CHECKS = FirestoreStore(CHECKS_COLL) if CHECKS_STORE == "firestore" else MemoryStore()

@app.post("/api/checks")
def add_check(rec: CheckRecord):
    if not rec.thumb.startswith("data:image/jpeg;base64,"):
        raise HTTPException(400, "thumb must be a JPEG data URL")
    CHECKS.add(rec.model_dump())
    return {"ok": True}

@app.get("/api/checks")
def list_checks(limit: int = 100):
    return {"store": CHECKS_STORE, "items": CHECKS.latest(max(1, min(limit, 200)))}


# ---------------- approved specification (Admin rule builder) ----------------
RULE_TYPES = ("each_exact", "each_max", "each_min", "cell_exact", "row_total", "col_total",
              "box_exact", "box_range", "walls", "color_all", "color_same")

class RuleIn(BaseModel):
    type: Literal[RULE_TYPES]                 # type: ignore[valid-type]
    on: bool = True
    p: dict[str, Union[int, str]] = Field(default_factory=dict, max_length=6)

class Layout(BaseModel):
    rows: int = Field(ge=1, le=12)            # the layout the program resolved to on the sample (for display)
    cols: int = Field(ge=1, le=12)

class SpecIn(BaseModel):
    program: RegionProgram                    # how photos are divided into regions (executed by the line)
    layout: Optional[Layout] = None
    rules: list[RuleIn] = Field(max_length=30)
    threshold: float = Field(0.5, ge=0.05, le=0.95)
    accuracy: Optional[dict] = None           # the report shown when it was approved (None for mock images)
    spec_text: str = Field("", max_length=4000)   # the engineer's written specification the rules came from

class MemorySpecs:
    def __init__(self): self.items = []
    def latest(self): return self.items[-1] if self.items else None
    def add(self, spec: dict): self.items.append(spec)

class FirestoreSpecs:
    """One document per approved version (id = zero-padded version), so every approval is kept."""
    def __init__(self, collection: str):
        from google.cloud import firestore
        self.db, self.coll, self.firestore = firestore.Client(), collection, firestore
    def latest(self):
        q = self.db.collection(self.coll).order_by("version", direction=self.firestore.Query.DESCENDING).limit(1)
        docs = [d.to_dict() for d in q.stream()]
        return docs[0] if docs else None
    def add(self, spec: dict):
        self.db.collection(self.coll).document(f"{spec['version']:06d}").set(spec)

SPECS = FirestoreSpecs(SPECS_COLL) if CHECKS_STORE == "firestore" else MemorySpecs()
SPEC_LOCK = threading.Lock()

@app.get("/api/spec")
def get_spec():
    return {"spec": SPECS.latest()}

@app.post("/api/spec")
def approve_spec(body: SpecIn, x_admin_token: str = Header(default="")):
    if ADMIN_TOKEN and x_admin_token != ADMIN_TOKEN:
        raise HTTPException(403, "admin token required to approve a specification")
    with SPEC_LOCK:
        prev = SPECS.latest()
        spec = {**body.model_dump(exclude={"program"}), "program": body.program.as_dict(),
                "version": (prev["version"] + 1) if prev else 1,
                "approved_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        SPECS.add(spec)
    return {"spec": spec}

# ---------------- Inspection Planner (Gemini on Vertex AI) ----------------
COLOURS = ["yellow", "orange", "red", "pink", "purple", "blue", "cyan", "green"]
RULE_PARAMS = {  # the parameters each rule type takes, with defaults (mirrors RULE_DEFS in public/js/rules.js)
    "each_exact": {"n": 1}, "each_max": {"n": 1}, "each_min": {"n": 1}, "cell_exact": {"r": 1, "c": 1, "n": 1},
    "row_total": {"r": 1, "n": 5}, "col_total": {"c": 1, "n": 3}, "box_exact": {"n": 15}, "box_range": {"a": 14, "b": 16},
    "walls": {}, "color_all": {"col": "yellow"}, "color_same": {},
}

PLAN_SCHEMA = {
    "type": "object",
    "properties": {
        "region_program": {"type": "object", "properties": {"steps": {"type": "array", "items": {
            "type": "object",
            "properties": {
                "op": {"type": "string", "enum": ["normalize_light", "grid_from_walls", "fixed_regions", "wall_segments"]},
                "rows": {"type": "string", "description": "grid_from_walls: 'auto' or a whole number 1-8"},
                "cols": {"type": "string", "description": "grid_from_walls: 'auto' or a whole number 1-8"},
                "missing_below": {"type": "number", "description": "wall_segments: wall-line strength below which a wall is missing (default 0.3)"},
                "regions": {"type": "array", "description": "fixed_regions only", "items": {
                    "type": "object", "properties": {
                        "id": {"type": "string"}, "box": {"type": "array", "items": {"type": "number"},
                                                          "description": "x0, y0, x1, y1 as fractions 0-1 of the photo"},
                        "row": {"type": "integer"}, "col": {"type": "integer"}},
                    "required": ["box"]}},
            },
            "required": ["op"]}}}, "required": ["steps"]},
        "rules": {"type": "array", "items": {"type": "object", "properties": {
            "type": {"type": "string", "enum": list(RULE_PARAMS)},
            "n": {"type": "integer"}, "r": {"type": "integer"}, "c": {"type": "integer"},
            "a": {"type": "integer"}, "b": {"type": "integer"}, "col": {"type": "string", "enum": COLOURS}},
            "required": ["type"]}},
        "sensitivity": {"type": "number", "description": "flag a region when P(violation) exceeds this; 0.5 unless the spec says otherwise"},
        "notes": {"type": "string", "description": "one or two sentences: how the spec was mapped, and any sentence that could not be expressed"},
    },
    "required": ["region_program", "rules", "sensitivity", "notes"],
}

PLANNER_INSTRUCTIONS = """You are the Inspection Planner for an automated visual inspection station.
An engineer gives you a written specification for a product and one sample photo of its container (it may be empty,
hold mock items, or hold real products). Plan the inspection as two programs that the station will execute:

1. region_program: how each photo is divided into regions, as an ordered list of steps from this fixed set:
   - normalize_light: auto-gain for the geometric steps. Use it first.
   - grid_from_walls (rows, cols): compartments found from the container's own wall lines. Use rows "auto" and cols
     "auto" unless the specification states the layout. Use this whenever the container is a grid of compartments.
   - fixed_regions (regions): explicit rectangles as fractions of the photo [x0, y0, x1, y1], only for containers that
     are not a grid. Give each region an id.
   - wall_segments (missing_below): measure every internal wall between grid compartments; include it whenever the
     specification says something about walls or separators. Default missing_below 0.3.
2. rules: what the regions must satisfy, using only these types (parameters in brackets; rows and columns count from 1):
   each_exact [n], each_max [n], each_min [n]: pins/items per compartment, exactly / at most / at least n
   cell_exact [r, c, n]: one compartment holds exactly n
   row_total [r, n], col_total [c, n]: total in a row / column
   box_exact [n], box_range [a, b]: total in the whole container
   walls: every compartment is enclosed by walls (needs wall_segments)
   color_all [col]: every item has colour col; color_same: all items share one colour
Express every checkable sentence of the specification as rules, and nothing that the specification does not say.
If a sentence cannot be expressed with these types, leave it out and say so in notes. Return only the JSON."""

_plan_times: list = []
_genai = {"client": None}

def call_gemini(model: str, jpeg: bytes, spec_text: str) -> dict:
    """One structured-output call to Gemini on Vertex AI. Returns the parsed JSON (validated afterwards)."""
    from google import genai
    from google.genai import types
    if _genai["client"] is None:
        _genai["client"] = genai.Client(vertexai=True, project=PROJECT_ID or None, location=PLANNER_LOC,
                                        http_options=types.HttpOptions(timeout=120_000))
    resp = _genai["client"].models.generate_content(
        model=model,
        contents=[types.Part.from_bytes(data=jpeg, mime_type="image/jpeg"), f"Written specification:\n{spec_text}"],
        config=types.GenerateContentConfig(system_instruction=PLANNER_INSTRUCTIONS, temperature=0,
                                           response_mime_type="application/json", response_json_schema=PLAN_SCHEMA))
    return json.loads(resp.text)

def normalize_plan(raw: dict) -> dict:
    """Turn the planner's JSON into a validated region program and rule list; refuse anything out of bounds."""
    steps = []
    for st in (raw.get("region_program") or {}).get("steps") or []:
        op = st.get("op")
        if op == "grid_from_walls":
            g = {"op": op, "inset": 6}
            for k in ("rows", "cols"):
                v = str(st.get(k, "auto")).strip().lower()
                g[k] = "auto" if v in ("", "auto") else int(v) if v.isdigit() else "auto"
            steps.append(g)
        elif op == "fixed_regions":
            steps.append({"op": op, "regions": [{k: g[k] for k in ("id", "box", "row", "col") if g.get(k) is not None}
                                                for g in st.get("regions") or []]})
        elif op == "wall_segments":
            steps.append({"op": op, "missing_below": float(st.get("missing_below", 0.3))})
        elif op == "normalize_light":
            steps.append({"op": op})
    program = RegionProgram(steps=steps).as_dict()          # raises on anything invalid
    rules = []
    for r in raw.get("rules") or []:
        t = r.get("type")
        if t not in RULE_PARAMS:
            continue
        p = {k: r.get(k, d) for k, d in RULE_PARAMS[t].items()}
        for k, v in p.items():
            if k == "col":
                if v not in COLOURS: raise ValueError(f"rule {t}: unknown colour {v!r}")
            elif not isinstance(v, int) or not 0 <= v <= 99 or (k in ("r", "c") and not 1 <= v <= 8):
                raise ValueError(f"rule {t}: {k}={v!r} is out of range")
        rules.append({"type": t, "on": True, "p": p})
    if not rules:
        raise ValueError("the planner produced no usable rules")
    sens = float(raw.get("sensitivity", 0.5))
    return {"program": program, "rules": rules, "sensitivity": min(0.95, max(0.05, sens)), "notes": str(raw.get("notes", ""))[:600]}

class PlanIn(BaseModel):
    spec_text: str = Field(min_length=3, max_length=4000)
    image: str
    model: str = Field(max_length=60)

@app.get("/api/plan/models")
def plan_models():
    return {"models": PLANNER_MODELS}

@app.post("/api/plan")
def plan(body: PlanIn, x_admin_token: str = Header(default="")):
    if ADMIN_TOKEN and x_admin_token != ADMIN_TOKEN:
        raise HTTPException(403, "admin token required to run the planner")
    if body.model not in PLANNER_MODELS:
        raise HTTPException(400, f"model must be one of {PLANNER_MODELS}")
    now = time.time()
    _plan_times[:] = [t for t in _plan_times if now - t < 60]
    if len(_plan_times) >= PLANS_PER_MIN:
        raise HTTPException(429, "the planner is busy; try again in a minute")
    _plan_times.append(now)
    im = decode_image(body.image)
    im.thumbnail((1600, 1600))
    buf = io.BytesIO(); im.save(buf, format="JPEG", quality=90)
    t0 = time.time()
    try:
        raw = call_gemini(body.model, buf.getvalue(), body.spec_text)
    except Exception as ex:
        raise HTTPException(502, f"{body.model} could not be reached: {type(ex).__name__}: {str(ex)[:300]}")
    try:
        out = normalize_plan(raw)
    except Exception as ex:
        raise HTTPException(422, f"{body.model} returned a plan that failed validation: {ex}")
    out.update(model=body.model, seconds=round(time.time() - t0, 1))
    return out

class RegionsIn(BaseModel):
    image: str
    program: Optional[RegionProgram] = None   # the draft region program (default: grid detected from the walls)

@app.post("/api/regions")
def regions(body: RegionsIn):
    """Run a region program on a sample photo: the regions and wall measurements, geometry only, no model, no GPU."""
    im = decode_image(body.image)
    program = body.program.as_dict() if body.program else DEFAULT_PROGRAM
    try:
        raw = run_region_program(im, program)
    except ValueError as ex:
        raise HTTPException(422, f"{ex}: this container needs the Inspection Planner (next step)")
    except Exception as ex:
        raise HTTPException(422, f"could not divide the photo: {ex}")
    for c in raw["cells"]:
        c["dist"] = None
    raw.update(w=im.width, h=im.height)
    return raw


# ---------------- static files: recorded results and the line page ----------------
app.mount("/replay", StaticFiles(directory=REPLAY_DIR, check_dir=False), name="replay")
app.mount("/", StaticFiles(directory=PUBLIC_DIR, html=True), name="line-page")

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=PORT)

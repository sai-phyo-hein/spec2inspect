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
import base64, binascii, io, json, os, re, threading, time, uuid
from urllib.parse import urlparse

import requests
import uvicorn
from fastapi import FastAPI, Header, HTTPException, Response
from typing import Literal, Optional, Union
from fastapi.staticfiles import StaticFiles
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, Field

from spec_core import CELL_TEXT, DEFAULT_PROGRAM, analyze, answer_distribution, chat_body, run_region_program
from spec_rules import validate_ruleset

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
PLANNER_THINK  = os.environ.get("PLANNER_THINKING", "LOW")        # Gemini thinking level: MINIMAL, LOW, MEDIUM, HIGH
PLANNER_TIMEOUT_S = int(os.environ.get("PLANNER_TIMEOUT_S", "240"))
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
    questions: list[dict] = Field(default_factory=list, max_length=4)   # the approved rule set's custom questions

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

def run_job(job_id: str, im: Image.Image, program: Optional[dict] = None, questions: tuple = ()):
    job = JOBS[job_id]
    with GPU_SLOT:
        job.update(state="running", started=time.time())
        try:
            t0 = time.time()
            deadline = t0 + GPU_DEADLINE_S
            raw = analyze(im, lambda c, t, a: ask_remote(c, t, a, deadline), cell_text=CELL_TEXT,
                          program=program or DEFAULT_PROGRAM, questions=questions, max_workers=GPU_PARALLEL)
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
    try:   # validate the questions the same way as in an approved rule set
        questions = tuple(validate_ruleset({"questions": body.questions, "rules": [{"test": "walls.missing == 0"}]})["questions"])
    except ValueError as ex:
        raise HTTPException(422, f"questions: {ex}")
    threading.Thread(target=run_job, args=(job_id, im, program, questions), daemon=True).start()
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
class Layout(BaseModel):
    rows: int = Field(ge=1, le=12)            # the layout the program resolved to on the sample (for display)
    cols: int = Field(ge=1, le=12)

class SpecIn(BaseModel):
    program: RegionProgram                    # how photos are divided into regions (executed by the line)
    layout: Optional[Layout] = None
    ruleset: dict                             # rules/v2: expression rules, parameters, questions (validated below)
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
        try:
            ruleset = validate_ruleset(body.ruleset)
        except ValueError as ex:
            raise HTTPException(422, f"rule set: {ex}")
        spec = {**body.model_dump(exclude={"program", "ruleset"}), "program": body.program.as_dict(), "ruleset": ruleset,
                "version": (prev["version"] + 1) if prev else 1,
                "approved_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        SPECS.add(spec)
    return {"spec": spec}

# ---------------- Inspection Planner (Gemini on Vertex AI) ----------------
COLOURS = ["yellow", "orange", "red", "pink", "purple", "blue", "cyan", "green"]

# ---- the planner runs as two Gemini calls: regions first, then rules (each streams its thinking to the page) ----
STEP_SCHEMA = {"type": "object", "properties": {
    "op": {"type": "string", "enum": ["normalize_light", "grid_from_walls", "fixed_regions", "wall_segments"]},
    "rows": {"type": "string", "description": "grid_from_walls: 'auto' or a whole number 1-8"},
    "cols": {"type": "string", "description": "grid_from_walls: 'auto' or a whole number 1-8"},
    "missing_below": {"type": "number", "description": "wall_segments: wall-line strength below which a wall is missing (default 0.3)"},
    "regions": {"type": "array", "description": "fixed_regions only", "items": {
        "type": "object", "properties": {
            "id": {"type": "string"}, "box": {"type": "array", "items": {"type": "number"},
                                              "description": "x0, y0, x1, y1 as fractions 0-1 of the photo"},
            "row": {"type": "integer"}, "col": {"type": "integer"}},
        "required": ["box"]}}},
    "required": ["op"]}

REGION_SCHEMA = {
    "type": "object",
    "properties": {
        "region_program": {"type": "object", "properties": {"steps": {"type": "array", "items": STEP_SCHEMA}}, "required": ["steps"]},
        "layout_sentences": {"type": "array", "items": {"type": "string"},
                             "description": "ids of the sentences (S1, S2, ...) that describe the container itself"},
        "notes": {"type": "string", "description": "one sentence: how the container is divided"},
    },
    "required": ["region_program", "layout_sentences", "notes"],
}

RULES_SCHEMA = {
    "type": "object",
    "properties": {
        "params": {"type": "array", "description": "named values the rules use as param.<name>", "items": {
            "type": "object", "properties": {
                "name": {"type": "string"}, "kind": {"type": "string", "enum": ["count", "colour"]},
                "default": {"type": "string", "description": "a whole number for count; a colour name, or any, for colour"},
                "operator": {"type": "boolean", "description": "true if the operator may change it on the line"},
                "label": {"type": "string"}},
            "required": ["name", "kind", "default", "operator"]}},
        "questions": {"type": "array", "description": "extra questions to ask the vision model in every region (max 4)", "items": {
            "type": "object", "properties": {
                "id": {"type": "string"}, "text": {"type": "string"}, "answer": {"type": "string", "enum": ["yesno", "count"]}},
            "required": ["id", "text", "answer"]}},
        "rules": {"type": "array", "items": {"type": "object", "properties": {
            "id": {"type": "string"}, "text": {"type": "string", "description": "what the rule checks, in plain words"},
            "for": {"type": "string", "description": "per-region rules only: all, row N, col N, cell R C or region NAME"},
            "test": {"type": "string", "description": "the expression"}},
            "required": ["id", "text", "test"]}},
        "coverage": {"type": "array", "description": "one entry per numbered sentence that is not a layout sentence", "items": {
            "type": "object", "properties": {
                "sentence": {"type": "string", "description": "the sentence id, e.g. S3"},
                "how": {"type": "string", "enum": ["rule", "operator_setting", "not_expressible"]},
                "rules": {"type": "array", "items": {"type": "string"}, "description": "ids of the rules that check it"},
                "params": {"type": "array", "items": {"type": "string"}, "description": "names of the params it introduces"},
                "reason": {"type": "string", "description": "for not_expressible: why"}},
            "required": ["sentence", "how"]}},
        "sensitivity": {"type": "number", "description": "flag a region when P(violation) exceeds this; 0.5 unless the spec says otherwise"},
        "notes": {"type": "string", "description": "one or two sentences: how the spec was mapped, and any sentence that could not be expressed"},
    },
    "required": ["params", "questions", "rules", "coverage", "sensitivity", "notes"],
}

REGION_INSTRUCTIONS = """You are the region planner of an automated visual inspection station.
An engineer gives you a written specification (numbered sentences S1, S2, ...) and one sample photo of the product's
container (it may be empty, hold mock items, or hold real products). Decide how each photo is divided into regions,
as an ordered list of steps from this fixed set:
- normalize_light: auto-gain for the geometric steps. Use it first.
- grid_from_walls (rows, cols): compartments found from the container's own wall lines. Use "auto" unless the
  specification states the layout, in which case give the numbers. Use this whenever the container is a grid.
- fixed_regions (regions): explicit rectangles as fractions of the photo [x0, y0, x1, y1], only for containers that are
  not a grid. Give each region a short id.
- wall_segments (missing_below): measure every internal wall; include it whenever the specification mentions walls
  or separators. Default missing_below 0.3.
Also list the sentences that describe the container itself (layout_sentences). Return only the JSON."""

RULES_INSTRUCTIONS = """You are the rules planner of an automated visual inspection station.
You get a written specification as numbered sentences S1, S2, ..., one sample photo of the container, and the regions
the station divides each photo into (already planned). Write one rule per checkable sentence, as an expression.
- A rule with "for" is checked in every selected region: "all", "row N", "col N", "cell R C" (counting from 1), or
  "region <id>". Measurements in a region: count (number of pushpins/items, 0-9), colour (the dominant colour of the
  items: yellow, orange, red, pink, purple, blue, cyan, green), q.<id> (the answer to one of your questions).
- A rule without "for" is checked once per box. Box values: total(count) or total(count, "row 2") (sum of counts),
  total(q.<id>) (sum of a count question, or the number of "yes" answers), distinct(colour) (number of colours),
  walls.missing (number of missing walls).
- Operators: == != < <= > >= + - and or not, parentheses. Strings in double quotes: colour == "yellow".
- params: named values used as param.<name>. If the specification lets the operator choose or change a value on the
  line, make it a param with operator true (e.g. "the operator chooses the colour to check" -> a colour param with
  operator true and a rule for all: colour == param.colour; "the operator can change the number per compartment" -> a
  count param with operator true used in count == param.n). Give each param a short label. An operator colour param
  defaults to "any" (matches every colour, so the check is not enforced until the operator picks one) unless the
  specification names a colour; never invent a required colour.
- questions: only when a sentence needs something other than counting items or colour (e.g. "Is the lid closed?").
  A short, visual question with answer yesno or count. At most 4.
- Each rule's text says, in plain words, what it checks, not the sentence it came from.
- Names: rule ids R1, R2, ...; parameter names and question ids short snake_case.
- coverage: exactly one entry for every sentence that is not a layout sentence: "rule" (the rule ids that check it),
  "operator_setting" (the operator params it introduces; each must be used by at least one rule, so add that rule if
  needed), or "not_expressible" (with the reason). Never skip a sentence.
Express every checkable sentence, and nothing the specification does not say. Return only the JSON."""

def numbered_sentences(spec_text: str) -> list:
    """The specification as sentences S1, S2, ... (one per line, or per sentence within a line)."""
    out = []
    for line in spec_text.splitlines():
        for part in re.split(r"(?<=[.!?])\s+", line.strip()):
            if part.strip(): out.append(part.strip())
    return out

def normalize_region(raw: dict) -> dict:
    """The region planner's answer as a validated region program (refuses anything out of bounds)."""
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
    return {"program": RegionProgram(steps=steps).as_dict(),
            "layout_sentences": [str(x).upper() for x in raw.get("layout_sentences") or []],
            "notes": str(raw.get("notes", ""))[:300]}

def normalize_rules(raw: dict) -> dict:
    """The rules planner's answer as a validated rule set plus sentence coverage. Rule ids are renumbered R1, R2, ...;
    parameter and question names are shortened to identifiers, and the expressions rewritten to match."""
    used, rename = set(), {}
    def short(name, prefix):
        base = re.sub(r"[^a-z0-9_]", "_", str(name).strip().lower()).strip("_") or prefix
        base = (prefix + "_" + base if not base[0].isalpha() else base)[:20]
        cand, k = base, 2
        while cand in used: cand, k = f"{base[:18]}{k}", k + 1
        used.add(cand); return cand
    params = {}
    for p in raw.get("params") or []:
        new = short(p.get("name"), "p"); rename[("param", str(p.get("name")))] = new
        kind = p.get("kind", "count"); default = str(p.get("default", "")).strip().lower()
        params[new] = {"kind": kind, "default": int(default) if kind == "count" and default.isdigit() else default,
                       "operator": bool(p.get("operator")), **({"label": str(p["label"])[:60]} if p.get("label") else {})}
    questions = []
    for q in raw.get("questions") or []:
        new = short(q.get("id"), "q"); rename[("q", str(q.get("id")))] = new
        questions.append({**q, "id": new})
    def rewrite(test):
        for (kind, old), new in sorted(rename.items(), key=lambda kv: -len(kv[0][1])):
            test = re.sub(rf"\b{kind}\.{re.escape(old)}\b", f"{kind}.{new}", test)
        return test
    rules, rule_ids = [], {}
    for i, r in enumerate(raw.get("rules") or []):
        rule = {k: r[k] for k in ("text", "for", "test") if r.get(k) not in (None, "")}
        rule["id"] = f"R{i + 1}"; rule_ids[str(r.get("id"))] = rule["id"]
        if "test" in rule: rule["test"] = rewrite(str(rule["test"]))
        rules.append(rule)
    ruleset = validate_ruleset({"sensitivity": min(0.95, max(0.05, float(raw.get("sensitivity", 0.5)))),
                                "params": params, "questions": questions, "rules": rules})
    coverage = [{"sentence": str(c.get("sentence", "")).upper(), "how": c.get("how", ""),
                 "rules": [rule_ids.get(str(x), str(x)) for x in c.get("rules") or []],
                 "params": [rename.get(("param", str(x)), str(x)) for x in c.get("params") or []],
                 **({"reason": str(c["reason"])[:200]} if c.get("reason") else {})} for c in raw.get("coverage") or []]
    return {"ruleset": ruleset, "coverage": coverage, "notes": str(raw.get("notes", ""))[:600]}

def rules_issues(rules: dict, n_sentences: int, layout: list) -> list:
    """What's missing from a valid rule plan: uncovered sentences, unused operator settings, unknown rule ids."""
    issues, rs = [], rules["ruleset"]
    covered = {c["sentence"] for c in rules["coverage"]} | set(layout)
    missing = [f"S{i}" for i in range(1, n_sentences + 1) if f"S{i}" not in covered]
    if missing: issues.append(f"no coverage entry for {', '.join(missing)}")
    used = " ".join(r["test"] for r in rs["rules"])
    for name, p in rs["params"].items():
        if p.get("operator") and f"param.{name}" not in used:
            issues.append(f"operator setting param.{name} is not used by any rule")
    ids = {r["id"] for r in rs["rules"]}
    for c in rules["coverage"]:
        if c["how"] == "rule" and (not c["rules"] or any(x not in ids for x in c["rules"])):
            issues.append(f"{c['sentence']} is marked as a rule but names no existing rule")
        if c["how"] == "operator_setting" and not any(rs["params"].get(x, {}).get("operator") for x in c["params"]):
            issues.append(f"{c['sentence']} is an operator setting but introduces no operator parameter")
    return issues

_plan_times: list = []
_genai = {"client": None}

def call_gemini(model, jpeg, text, instructions, schema, on_thought=None, on_text=None) -> dict:
    """One structured-output call to Gemini on Vertex AI, streamed: thought summaries and the JSON as it forms are
    passed to the callbacks as they arrive. Thinking is kept LOW (fast; the validator checks the result anyway);
    models that don't take a thinking level get the call without it. Returns the parsed JSON."""
    from google import genai
    from google.genai import types
    if _genai["client"] is None:
        _genai["client"] = genai.Client(vertexai=True, project=PROJECT_ID or None, location=PLANNER_LOC,
                                        http_options=types.HttpOptions(timeout=PLANNER_TIMEOUT_S * 1000))
    def config(thinking: bool):
        think = {"thinking_config": types.ThinkingConfig(thinking_level=PLANNER_THINK, include_thoughts=True)} if thinking and PLANNER_THINK else {}
        return types.GenerateContentConfig(system_instruction=instructions, temperature=0,
                                           response_mime_type="application/json", response_json_schema=schema, **think)
    contents = [types.Part.from_bytes(data=jpeg, mime_type="image/jpeg"), text]
    def run(thinking: bool) -> str:
        answer = []
        for chunk in _genai["client"].models.generate_content_stream(model=model, contents=contents, config=config(thinking)):
            for cand in chunk.candidates or []:
                for part in (cand.content.parts if cand.content else None) or []:
                    if not part.text: continue
                    if getattr(part, "thought", False):
                        if on_thought: on_thought(part.text)
                    else:
                        answer.append(part.text)
                        if on_text: on_text(part.text)
        return "".join(answer)
    try:
        out = run(True)
    except Exception as ex:
        if "thinking" not in str(ex).lower():
            raise
        out = run(False)
    return json.loads(out)

def transient(ex: Exception) -> bool:
    """Errors worth one more try: timeouts, overload, rate limits."""
    msg = str(ex).upper()
    return any(k in msg for k in ("DEADLINE_EXCEEDED", "504", "503", "UNAVAILABLE", "429", "RESOURCE_EXHAUSTED", "TIMEOUT", "TIMED OUT"))

class PlanIn(BaseModel):
    spec_text: str = Field(min_length=3, max_length=4000)
    image: str
    model: str = Field(max_length=60)

@app.get("/api/plan/models")
def plan_models():
    return {"models": PLANNER_MODELS}

PLAN_JOBS: dict = {}
STREAM_CAP = 20_000

def plan_sync(body: PlanIn, job: Optional[dict] = None) -> dict:
    """Plan in two Gemini calls: the region program, then the rules (told what the regions are on the sample).
    Each call gets at most two attempts: a retry on a timeout/overload, or one correction when the answer fails
    validation or misses a sentence. `job` (optional) receives the streamed thinking and output, and the stages."""
    job = job if job is not None else {}
    im = decode_image(body.image)
    small = im.copy(); small.thumbnail((1024, 1024))              # enough to plan regions; smaller is faster
    buf = io.BytesIO(); small.save(buf, format="JPEG", quality=88)
    sentences = numbered_sentences(body.spec_text)
    spec = "Written specification, as numbered sentences:\n" + "\n".join(f"S{i}: {t}" for i, t in enumerate(sentences, 1))
    t0 = time.time()

    def stage(name, instructions, schema, prompt, normalize, issues_of=None):
        stream = job.setdefault(name, {"thoughts": "", "output": "", "attempts": 0})
        add = lambda key: (lambda t: stream.__setitem__(key, (stream[key] + t)[-STREAM_CAP:]))
        result, problems = None, []
        for attempt in range(2):
            stream["attempts"] = attempt + 1; stream["output"] = ""
            ask = prompt if not problems else prompt + "\n\nYour previous answer had these problems; return a corrected one:\n- " + "\n- ".join(problems)
            try:
                raw = call_gemini(body.model, buf.getvalue(), ask, instructions, schema, add("thoughts"), add("output"))
            except Exception as ex:
                if attempt == 0 and transient(ex):
                    print(f"planner {name}: {type(ex).__name__} ({str(ex)[:80]}); retrying once", flush=True)
                    problems = []; time.sleep(3); continue
                raise HTTPException(502, f"{body.model} could not be reached ({name}): {type(ex).__name__}: {str(ex)[:300]}")
            try:
                cand = normalize(raw)
            except HTTPException as ex:
                problems = [f"validation failed: {ex.detail}"]; continue
            except Exception as ex:
                problems = [f"validation failed: {ex}"]; continue
            result, problems = cand, (issues_of(cand) if issues_of else [])
            if not problems: break
        if result is None:
            raise HTTPException(422, f"{body.model} returned a {name} plan that failed validation: {'; '.join(problems)}")
        return result, problems

    job["stage"] = "regions"
    regions, _ = stage("regions", REGION_INSTRUCTIONS, REGION_SCHEMA, spec, normalize_region)
    try:                                                          # what the program produces on this sample
        res = run_region_program(im, regions["program"])
        seen = f"{res['rows']} x {res['cols']} regions" + (f", {len(res['walls'])} measured walls" if res["walls"] else "") + \
               (f"; region ids: {', '.join(str(c['id']) for c in res['cells'] if c.get('id'))}" if any(c.get("id") for c in res["cells"]) else "")
    except Exception as ex:
        raise HTTPException(422, f"the planned region program doesn't run on this sample: {ex}")
    job["region_result"] = {"program": regions["program"], "notes": regions["notes"]}

    job["stage"] = "rules"
    prompt = spec + f"\n\nRegions (already planned): {json.dumps(regions['program'])}\nOn the sample photo this gives {seen}." + \
             (f"\nLayout sentences (handled by the regions, no coverage needed): {', '.join(regions['layout_sentences'])}" if regions["layout_sentences"] else "")
    rules, warnings = stage("rules", RULES_INSTRUCTIONS, RULES_SCHEMA, prompt, normalize_rules,
                            lambda r: rules_issues(r, len(sentences), regions["layout_sentences"]))
    coverage = [{"sentence": s, "how": "layout", "rules": [], "params": []} for s in regions["layout_sentences"]] + rules["coverage"]
    return {"program": regions["program"], "ruleset": rules["ruleset"], "coverage": coverage, "warnings": warnings,
            "notes": " ".join(x for x in (regions["notes"], rules["notes"]) if x),
            "attempts": job["regions"]["attempts"] + job["rules"]["attempts"], "model": body.model,
            "seconds": round(time.time() - t0, 1), "sentences": [{"id": f"S{i}", "text": t} for i, t in enumerate(sentences, 1)]}

def plan_guard(body: PlanIn, x_admin_token: str):
    if ADMIN_TOKEN and x_admin_token != ADMIN_TOKEN:
        raise HTTPException(403, "admin token required to run the planner")
    if body.model not in PLANNER_MODELS:
        raise HTTPException(400, f"model must be one of {PLANNER_MODELS}")
    now = time.time()
    _plan_times[:] = [t for t in _plan_times if now - t < 60]
    if len(_plan_times) >= PLANS_PER_MIN:
        raise HTTPException(429, "the planner is busy; try again in a minute")
    _plan_times.append(now)

def plan(body: PlanIn, x_admin_token: str = ""):
    """Synchronous planning (used by tests)."""
    plan_guard(body, x_admin_token)
    return plan_sync(body)

@app.post("/api/plan")
def plan_start(body: PlanIn, x_admin_token: str = Header(default="")):
    """Start planning and return at once; the page polls GET /api/plan/{id} for the streamed thinking and the result.
    Planning can take longer than the one-minute limit Firebase Hosting puts on a request."""
    plan_guard(body, x_admin_token)
    decode_image(body.image)                      # reject a bad image now, not inside the job
    now = time.time()
    for k in [k for k, j in PLAN_JOBS.items() if now - j["created"] > JOB_TTL_S]:
        PLAN_JOBS.pop(k, None)
    job_id = uuid.uuid4().hex[:12]
    job = PLAN_JOBS[job_id] = {"state": "running", "created": now, "stage": "starting"}
    def work():
        try:
            job.update(state="done", result=plan_sync(body, job))
        except HTTPException as ex:
            job.update(state="error", status=ex.status_code, error=ex.detail)
        except Exception as ex:
            job.update(state="error", status=500, error=f"{type(ex).__name__}: {ex}")
        print(f"plan {job_id}: {job['state']} in {time.time() - job['created']:.1f}s {job.get('error', '')}", flush=True)
    threading.Thread(target=work, daemon=True).start()
    return {"id": job_id}

@app.get("/api/plan/{job_id}")
def plan_status(job_id: str):
    job = PLAN_JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "unknown or expired planning job")
    out = {"state": job["state"], "stage": job.get("stage"), "elapsed": round(time.time() - job["created"], 1),
           "regions": job.get("regions"), "rules": job.get("rules"), "region_result": job.get("region_result")}
    if job["state"] == "done": out["result"] = job["result"]
    if job["state"] == "error": out.update(error=job["error"], status=job["status"])
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


# ---------------- caching: page files are revalidated on every load, recorded images are immutable ----------------
@app.middleware("http")
async def cache_headers(request, call_next):
    resp = await call_next(request)
    path = request.url.path
    if path.startswith("/replay/images/"):
        resp.headers.setdefault("Cache-Control", "public, max-age=86400, immutable")
    elif not path.startswith("/api/"):
        resp.headers.setdefault("Cache-Control", "no-cache")      # HTML/JS/CSS always match after a deploy
    return resp


# ---------------- static files: recorded results and the line page ----------------
app.mount("/replay", StaticFiles(directory=REPLAY_DIR, check_dir=False), name="replay")
app.mount("/", StaticFiles(directory=PUBLIC_DIR, html=True), name="line-page")

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=PORT)

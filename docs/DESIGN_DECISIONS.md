# Design decisions

Why spec2inspect is built the way it is: each choice, the alternatives we considered, and what would make us change it.
Written to answer the questions a reviewer is likely to ask.

## 30-second answers

| Question | Short answer |
|---|---|
| Why your own GPU service instead of a managed model API? | The checker must be an **open model that can run inside the plant**, return **token probabilities**, and cost nothing when idle. Gemma 4 E4B on an L4 that scales to zero does all three. |
| Why Cloud Run? | GPUs with **per-second billing and scale to zero**, no cluster to run, and private service-to-service authentication. |
| Why two services? | The **GPU only runs when someone inspects a photo**; the page and replay run on cheap CPU. The GPU service is private. |
| Why Firebase Hosting? | A **CDN-served static page** at a clean URL, with `/api` and `/replay` forwarded to Cloud Run. Static front end and logic stay separate. |
| Why Firestore? | A **serverless, shared inspection log**: one document per live inspection, written by our server, readable on any device, free at this scale. |
| Why plain JavaScript and a simple page? | **No build step**: what we test is exactly what we deploy. A single-screen station UI doesn't need a framework. The code is still modular, **type-checked in strict mode**, and unit-tested. |
| Does it scale? | **Speed:** 3.6 s per box measured on two older T4 GPUs, all 15 compartments in parallel on the L4. **Capacity:** each box is independent, so throughput grows with GPU instances; the web, page and data layers are serverless. |
| Where is Gemini used? | As the **Inspection Planner**: once per product, it turns the written spec and a sample image into a region program and rules (validated JSON). The per-box checker must be open, on-premises and cheap, which is Gemma's role. |

---

## 1. Model serving

### Why a custom GPU service with llama.cpp and Gemma 4 E4B?
- **Open model, runs where the images are.** Many plants won't send production images to an outside API. The same
  container can run on a GPU inside the plant; Cloud Run is how we host it for the demo.
- **Token probabilities.** Our scoring reads the probability of each answer (0-9 pins) from a single forward pass;
  that is what took the method from 54% to 94% AUROC. llama.cpp's OpenAI-compatible server returns these.
- **The exact build we evaluated.** Google's official **QAT Q4_0** Gemma 4 E4B is the model behind every number we
  report (Kaggle, 2× T4). Serving the same file keeps live results consistent with the measured ones. Both files are
  verified against Google's published checksums at build time.
- **Cost.** The L4 is Cloud Run's lowest-cost GPU, and the service scales to zero, so it costs nothing between
  inspections. Each inspected box costs roughly US$0.001-0.002 at our measured throughput.

**Alternatives considered**
- *Google's prebuilt vLLM container for Gemma 4:* official and well documented, but its recommended setup uses a
  larger, more expensive GPU and full-precision weights (16 GB) rather than the 4-bit build we evaluated.
- *A managed endpoint (Vertex AI):* a dedicated endpoint is billed while its nodes are deployed; Cloud Run bills only
  while an instance runs.
- *A hosted API such as Gemini:* a closed model, images leave the plant, and per-answer probabilities aren't the
  interface. Gemini fits a different job (see section 7).

**When we'd change it:** for a plant deployment, the same image runs on an on-premises GPU box. If accuracy needs
more headroom (the breakfast box), we'd compare an 8-bit build on the L4 first.

### Why 4-bit (Q4_0) and not 8-bit?
The QAT build was trained to cope with 4-bit weights, so it keeps most of the full model's quality. It's half the
memory: two servers fit on a 16 GB T4, which doubled our parallel checks on Kaggle. All reported numbers come from
it. An 8-bit comparison is planned for the next category.

### Why one GPU service with 16 parallel slots?
A box has 15 compartments; with 16 slots all 15 questions run at once on one L4 instead of in four rounds. Each
answer stops after two tokens, since only the first token's probabilities are used.

---

## 2. Cloud architecture

### Why Cloud Run (not GKE or a VM)?
GPU support with **per-second billing and scale to zero**, no cluster or VM to patch, HTTPS and IAM built in, and
deployment from a container image. A VM would bill around the clock; GKE would add cluster operations a two-person
team doesn't need.

### Why split into `spec-web` (CPU) and `spec-gpu` (GPU)?
- **Cost isolation:** replay, the rule editor and the Check page run on a small CPU service; the GPU starts only
  when a photo is inspected in Live mode, and stops again when idle.
- **Security:** `spec-gpu` is **private**. Only `spec-web`'s service account may call it (Cloud Run invoker role,
  identity tokens), so the model can't be used directly from the internet.
- **Independent scaling and deploys:** the web service rebuilds in seconds; the GPU image (with the model inside)
  is built once and reused.

### Why do live inspections run as a job the page polls?
A GPU that has scaled to zero needs time to start, which can exceed Firebase Hosting's one-minute limit on requests
to Cloud Run. The page creates a job (`POST /api/live/jobs`) and checks its progress (`GET /api/live/jobs/{id}`), so
no request waits on the GPU. Switching to Live also wakes the GPU in the background, so Inspect is usually fast.

### Why is the replay in Cloud Storage, mounted into Cloud Run?
One copy of the 240 recorded inspections, uploaded once with `rsync` (only changed files), mounted read-only into
`spec-web`. Images stay out of git and out of the container image, so web deploys upload only code.

---

## 3. Firebase Hosting

### Why put Firebase Hosting in front of Cloud Run?
- The line page is **static files** (HTML, CSS, JavaScript modules); Hosting serves them from Google's CDN at a clean
  address (`spec2inspect.web.app`).
- **Rewrites** forward `/api/**` and `/replay/**` to `spec-web`, so the page uses relative paths and works the same
  on Hosting or directly on Cloud Run.
- It separates the static front end from the logic and AI on Cloud Run, which is the standard Firebase + Cloud Run
  pattern.

**Alternative:** serving everything from Cloud Run, which still works (and is our fallback link). Hosting adds CDN
caching and a stable public URL at no meaningful cost.

---

## 4. Firestore

### Why Firestore for the inspection log?
- **Serverless and shared:** every live inspection is one document in `inspections`; the Check page shows everyone's
  results on any device, grouped by day.
- **No schema migrations:** each record is self-contained (photo with overlay, verdict, counts, findings, and the
  exact rules that applied), so old results stay readable after the rules change.
- **Free at this scale**, in the same region as the services.

### Why don't browsers talk to Firestore directly?
The page sends results to `spec-web`, which writes them with its own service account. The Firestore security rules
**deny all direct access**, so there are no Firebase keys in the page and no way to read or wipe the log from
outside. The endpoint caps every field's size. The Check page can't clear the shared log.

**Alternatives:** Cloud SQL (a database server to run, for append-only records), BigQuery (great for analytics on
many lines later, not for a live log), browser storage only (not shared; kept as a fallback).

---

## 5. Front end

### Why plain JavaScript and a simple page, not React or another framework?
- **No build step:** browsers run the files as they are, so what we test is exactly what's deployed on Hosting and
  Cloud Run. Fewer moving parts before a deadline.
- **Small and fast:** about 100 KB of code, styles and markup in total, with no framework to download; it loads quickly on a factory tablet or a station screen.
- **One screen:** a station UI with a conveyor, a pipeline panel and a rule editor doesn't need routing or a
  component framework.

### Is it maintainable?
- **Modular:** 17 ES modules, one responsibility each (rule engine, scene, station, panel, tray, Check page, ...).
- **Type-checked:** every module is checked by the TypeScript compiler in **strict mode** (`// @ts-check`, JSDoc
  types, shared types in `types/model.d.ts`), with zero errors and nothing to compile.
- **Tested:** the rule engine is pure logic with unit tests (`npm run check`).
- **Path forward:** moving to `.ts` files or Web Components is mechanical, since the types already exist.

### Why an Admin page with approval?
The page is a pipeline: the engineer's **written specification and a sample image** go in; the **region plan**
(detected from the sample's own wall lines) and the **rules as JSON** come out; the result is **verified** on the
sample and for accuracy on labelled recordings before anything reaches the line. The rules are JSON so that the
Gemini Inspection Planner can generate them later without changing the line: today they are prepared for the pushpin
box and validated against a schema. Only an **approved version**
runs on the production line, live inspections and the Check page, and every approval is kept in Firestore with its
accuracy report, so each result can be traced to the exact specification that produced it. When the samples are
mock images, accuracy can't be measured (no ground truth), and the page says so instead of showing a number.

### Why are region division and rules programs, and not generated code?
The line doesn't hard-code how a container is divided: it executes a **region program**, a JSON list of operations
from a fixed set (`normalize_light`, `grid_from_walls`, `fixed_regions`, `wall_segments`), interpreted by
`spec_core.run_region_program`. The planner outputs this program, so a new container layout needs a new program, not
new code. We deliberately chose a declarative program over letting a model write Python: it is validated before it
runs (unknown operations and out-of-range values are refused), it can't do anything outside region division, it runs
the same on Kaggle, Cloud Run and in the Admin preview, and it is unit-tested on synthetic trays. Extending what the
planner can express means adding an operation, reviewed once, rather than trusting generated code on a factory line.

Rules follow the same idea one level up: an **expression language** over region measurements (`count`, `colour`,
answers to custom questions, `walls.missing`), with per-region rules (`for`), box rules, `total()` / `distinct()`,
comparisons, logic and named parameters. The planner can compose any rule this grammar can say, which is far more than a
fixed list of rule types, but every expression is parsed and validated before it runs, can only read measurements, and
is evaluated against Gemma's answer *distributions*, so the sensitivity setting and the accuracy report keep working.
The original rule types convert to expressions exactly: on the 240 recordings, the expression engine gives the same
verdict and the same flagged compartments as the old engine for every box.

### Why does the browser apply the rules?
Gemma's answers are stored as probabilities per compartment, so the rules (counts, totals, colours, walls) can be
re-applied instantly when an engineer edits them, with no model call. That's the "change the rule, no retraining"
moment in the demo.

---

## 6. Backend and data

### Why Python (FastAPI) for `spec-web`?
The grid finding, wall measurement and model calls are the **same Python code** (`spec_core.py`) used in the Kaggle
evaluation, so the deployed system behaves like the measured one. FastAPI is small, typed and serves the static
page, the API and the replay from one process.

### Why are walls and colours checked without the model?
We tested it: asked whether a wall was present, Gemma said yes almost everywhere (47.1% AUROC); asked to count
compartments, it answered 2, 3 or 4 almost equally (50.0%). Measuring the wall line in pixels fixed it (93.8% to
96.3%). So each rule goes to the checker that suits it: the model counts objects, geometry checks structure, pixels
give colour.

### Why Kaggle and Hugging Face?
Kaggle's free 2× T4 GPUs ran the evaluation, the 240-inspection recording and the throughput tests, as reproducible
notebooks in `notebooks/`. Hugging Face hosts the private dataset and replay bundle, and the **public sample photos**
for the Live tray, under the dataset's own licence (CC BY-NC-SA 4.0, with the changes stated).

### Why a replay mode at all?
It shows real, recorded Gemma results for 240 boxes at zero cost and with no waiting, and every number we report can
be reproduced from the notebooks. Live mode then proves the same pipeline works on a new photo, on demand.

---

## 7. Scalability: speed and capacity

### What we measured
| Measure | Result | Where |
|---|---|---|
| Time per box (one station) | **3.6 s** median, 3.75 s at the 95th percentile | Kaggle, 2× NVIDIA T4, 4 servers, 240 boxes |
| Throughput, one station | **16.7 boxes/min** | same |
| Throughput, GPUs fully used | **23.9 boxes/min** | same, several boxes in flight |
| Cost per box (Live) | about **US$0.001-0.002** | L4 list price, measured throughput |

At 16.7 boxes/min, one station fully covers a manual kitting cell and most case packers (5-20/min), and 28-48% of an
automated kitting line (35-60/min). These are line speeds from public machine specifications.

### Speed: how each box gets faster
- **All compartments at once:** the GPU service runs 16 parallel slots, so a box's 15 compartment questions are
  answered together instead of in rounds.
- **Minimal work per question:** each answer stops after two tokens, since only the first token's probabilities are
  used; the image crops are small.
- **Newer hardware:** the 3.6 s was measured on T4s (a 2018 GPU); the deployed service runs on an L4, a newer
  generation. The real per-box time on the L4 is shown for every live inspection (line log and Check page).
- **No cold start in use:** switching to Live wakes the GPU in the background; during operation the instance stays
  warm between boxes.
- **Further, if needed:** fewer image tokens per crop, asking about several compartments per request, or the smaller
  Gemma 4 E2B. Each changes the method, so each would be re-measured on the benchmark before use.

### Capacity: how throughput grows
- **Boxes are independent.** No state is shared between inspections, so throughput grows roughly linearly with GPU
  instances: raise `--max-instances` on `spec-gpu` (and the regional GPU quota) and Cloud Run spreads the load.
- **Per line or per station.** The same container can run as one GPU service per production line, or on a GPU box at
  each station inside the plant, so capacity is added where the lines are.
- **The rest is serverless.** Firebase Hosting serves the page from a CDN; Cloud Storage serves the recorded images;
  Firestore scales writes and reads automatically; `spec-web` is a CPU service that scales out.
- **Faster lines:** more GPUs or stations, or sampled inspection where the quality plan allows it.

### What changes at larger scale (known, deliberate prototype limits)
| Today (prototype) | At scale |
|---|---|
| Live jobs are tracked in `spec-web`'s memory, so it runs as one instance | Keep job state in Firestore (or Memorystore) and let `spec-web` scale out |
| One photo on the line at a time in Live (the drop zone waits for each result) | Several photos in flight; raise the per-instance limit to the GPU's slots and add instances |
| Photo thumbnails stored inside each Firestore record | Thumbnails in Cloud Storage, metadata in Firestore; export to BigQuery for line analytics |
| `spec-gpu` capped at one instance (cost guard) | Size instances and quota to the line rate |

### Scaling to new products costs no compute
A new product or menu needs a new **rule set**, not a new model: no images to collect, no training run, no GPU
time. Cost grows with boxes inspected, not with the number of products, which is the point for lines that change
product daily.

---

## 8. Gemini: the Inspection Planner

### Why Gemini for planning and Gemma for checking?
They do different jobs. **Planning** happens once per product: read the engineer's specification, look at a sample of
the container, decide how to divide it into regions and which rule checks each sentence. That is a reasoning task
worth a large model, and its cost is a few cents per product. **Checking** happens on every box, possibly inside the
plant, thousands of times a day: that needs an open model with token probabilities, on hardware that scales to zero.

### How is the planner kept safe?
Gemini answers with **structured output** constrained to a JSON schema (the region operations and rule types the line
knows). `spec-web` then validates the plan again (unknown operations, out-of-range grids or parameters are refused).
The Admin page shows the planner's notes (how each sentence was mapped, what couldn't be expressed), divides the
sample with the planned region program, and measures accuracy on labelled images. Nothing reaches the line until an
engineer approves it, and every approved version is kept in Firestore. The endpoint is rate-limited and can require
an admin token.

### What's next for the planner
Rules that refer to named regions (the breakfast box: "left half", "right half"), planning for non-grid containers
with `fixed_regions`, and a counterexample loop: good samples must pass and known-bad samples must fail before a plan
can be approved.

---

## 9. Cost and security controls

| Control | Where |
|---|---|
| GPU and web services scale to zero; `spec-gpu` has at most one instance | `deploy.sh` |
| GPU runs only for Live inspections; the line itself is CPU | architecture |
| Old container images deleted automatically (keep the latest 2) | Artifact Registry cleanup policy |
| Build uploads deleted after 7 days | staging bucket lifecycle rule |
| Budget alert on the billing account | Google Cloud Billing |
| GPU service private (invoker role, identity tokens) | `deploy.sh`, `app_web.py` |
| Planner rate-limited (6 plans/min), schema-constrained output, validated again server-side | `app_web.py` |
| Firestore deny-all rules; writes only through `spec-web`, size-capped | `firestore.rules`, `app_web.py` |
| Uploads limited to 8 MB and readable images | `app_web.py` |
| No tokens or keys in the repository | `.gitignore`, Kaggle and Cloud secrets |

# spec2inspect

**Spec-to-Inspection:** quality checks written in words, not trained on images. Gemini plans the inspection from a written specification; Gemma 4 checks every compartment of every box; Cloud Run, Firestore and Firebase Hosting run the line.

```
browser ──> spec-web (Cloud Run, CPU, public, scales to zero)
              ├─ slideshow / browsing: replays Gemma 4 answers recorded on Kaggle,
              │  re-applies the rules live (pins per compartment, threshold, wall check)
              └─ Live mode: Upload + Inspect your own photo ──> spec-gpu (Cloud Run, 1x L4, private, scales to zero)
```

The GPU runs only when a photo is inspected in Live mode. Everything else is CPU.

The line page (`/` on `spec-web`, source layout in `web/README.md`):
- **Replay** (default): boxes slide in, four arms clamp at the camera, the AI pipeline panel shows each step, and the
  diverter sends boxes to GOOD or REJECT, using answers recorded on Kaggle; the written rules are re-applied live.
- **Live** (switch at top right): the recorded boxes leave the line and only your photos run. The left panel becomes a
  photo tray (sample photos from the public dataset `saiphyohein/spec2inspect-images`, served same-origin by
  `/api/samples`; recorded boxes if it is unavailable). Drag a photo onto the **drop zone at the start of the conveyor**,
  or press **Upload** inside it (an upload also joins the tray). The photo travels down the belt and is inspected
  automatically when it reaches the camera: Gemma 4 on `spec-gpu` (`POST /api/live/jobs`, then the page polls
  `GET /api/live/jobs/{id}`), then the verdict and the diverter. The drop zone stays disabled until that photo has been
  inspected. Set `SAMPLES_REPO` on `spec-web` to use a different dataset.
- **Admin** (the settings menu, gear icon at the top right): the **rule builder**, laid out as a pipeline. The line metrics and the Replay/Live/Check switch are hidden there.
  1. **Inputs:** the engineer's written specification, a sample image (an empty container, mock items, or a photo),
     and the **planner model** (Gemini). **Process** sends them to the Inspection Planner; changing an input marks the
     output as stale.
  2. **Planner output:** two programs the line executes. The **region program** (JSON) says how each photo is
     divided: an ordered list of operations from a fixed set (`normalize_light`, `grid_from_walls` with rows/cols
     `"auto"` or fixed, `fixed_regions` for non-grid trays, `wall_segments` with the missing-wall threshold), validated
     by `spec-web` and run by `spec_core.run_region_program` on the sample (`POST /api/regions`, geometry only), on live
     photos and in the line. The **rule set** (JSON, `rules/v2`) says what each region and box must satisfy, as
     **expression rules**: `{"for": "all", "test": "count == param.n"}` is checked in every region,
     `{"test": "total(count) == 15 and walls.missing == 0"}` once per box. Measurements: `count` (Gemma), `colour`
     (pixels), `q.<id>` (custom questions the planner asks Gemma in every region, yes/no or a count), `walls.missing`;
     box functions `total()` and `distinct()`; named **parameters**, some marked operator-adjustable, which appear as
     controls on the line. Expressions are parsed and validated (browser `expr.js`, server `spec_rules.py`) and only
     ever read measurements.
     Both come from the **Gemini Inspection Planner** (`POST /api/plan`), validated by `spec-web`; the planner's notes
     say how each sentence was mapped and what couldn't be expressed. Both remain editable for corrections.
  3. **Verification:** the sample divided into numbered regions with its walls, and an **accuracy report** on the 240
     labelled recordings (a checkbox, disabled for mock photos, which have no ground truth).
  4. **Approval:** approved versions are stored in Firestore (`specs`, `GET/POST /api/spec`, with the written
     specification and the accuracy report), and the production line, live inspections and the Check page always use the
     latest one. "Discard draft" returns to it. Set `ADMIN_TOKEN` when deploying to require a token for approval.
- **Check**: every photo inspected live, from the shared **inspection log in Firestore** (`POST/GET /api/checks` on
  `spec-web`; browsers never access Firestore directly), grouped by day, as cards with the photo and its overlay, the
  verdict, the pins counted per compartment, the findings and the rules that applied; filter by passed or rejected,
  download as CSV. If the log can't be reached, the page shows this browser's own last 40 results.

## Repository layout

```
.
├── web/          spec-web: line page (public/), live-inspection API, type definitions, unit tests  → web/README.md
├── gpu/          spec-gpu: Gemma 4 E4B on llama.cpp, NVIDIA L4
├── docs/         DESIGN_DECISIONS.md: why each technology was chosen
├── notebooks/    Kaggle runs with outputs: evaluation (93.8% / 96.3% AUROC), replay recording, sample photos → notebooks/README.md
├── deploy.sh · teardown.sh · prepare_replay.sh · deploy_hosting.sh · check_planner_model.sh
├── firebase.json · firestore.rules · .firebaserc   Firebase Hosting (page + rewrites to Cloud Run), deny-all rules
└── .gitignore    keeps data, models, node_modules and secrets out of git
```

Recorded results and model weights are not in git or in the web image: `prepare_replay.sh` puts the replay in a
Cloud Storage bucket once, and Cloud Run mounts it read-only into `spec-web`. Each web deploy uploads only the code
(a few hundred KB). The GPU image, with the model inside, is built once and reused (`REBUILD_GPU=1` to rebuild).
Build uploads go to `gs://<project>-build-staging` and are deleted after 7 days.

## Google Cloud and Firebase

Why each technology was chosen, and the alternatives considered: [docs/DESIGN_DECISIONS.md](docs/DESIGN_DECISIONS.md).


- **Cloud Run:** `spec-web` (line page, APIs, CPU, scales to zero) and `spec-gpu` (Gemma 4 E4B on an NVIDIA L4,
  private, scales to zero, used only when a photo is inspected in Live mode).
- **Firebase Hosting:** serves the line page from `web/public`; `/api/**` and `/replay/**` are forwarded to `spec-web`.
- **Firestore:** the inspection log behind the Check page (collection `inspections`, one document per live
  inspection) and the approved specifications from the Admin page (collection `specs`, one document per version).
- **Gemini (Vertex AI):** the **Inspection Planner** on the Admin page. Given the engineer's written specification and
  a sample image (an empty container, mock items, or a photo), Gemini returns a region program and rules as
  structured JSON (`POST /api/plan`, schema-constrained output). `spec-web` validates both before the page shows them,
  the page verifies them on the sample and for accuracy, and only an approved plan reaches the line. Gemini plans once
  per product; Gemma 4 checks every box. Check the model is callable with `./check_planner_model.sh`.

## 1. Record on Kaggle (free GPUs)

Run `notebooks/spec2inspect-record-replay.ipynb` (GPU T4 x2, secret `HF_TOKEN` with write access). It records 40 images x 6
colour/lighting variants, stores every compartment's full answer distribution, prints a robustness table, and
uploads `replay_bundle.tar.gz` to `saiphyohein/loco-zeroshot` (private).

## 2. Deploy (Cloud Shell)

```bash
gcloud config set project YOUR_PROJECT_ID
HF_TOKEN=hf_xxx ./prepare_replay.sh     # once: bundle -> web/replay -> gs://<project>-replay (only changed files upload)
./check_planner_model.sh gemini-3.5-pro # confirm the Gemini model is callable from this project (Vertex AI, global)
./deploy.sh                             # builds and deploys spec-gpu (private) and spec-web (public), creates Firestore
./deploy_hosting.sh                     # Firebase Hosting: the line page at https://<project>.web.app
DEPLOY_GPU=0 ./deploy.sh                # alternative: replay-only page, no GPU service at all
```

## What costs money, and when

- **spec-web** (1 CPU, 2 GiB, request-based billing): billed only while a request is open. The slideshow keeps
  one request open while a tab plays, and stops by itself after 30 minutes (`AUTOPLAY_MAX_MIN`). Light demo use
  should stay within Cloud Run's CPU free tier.
- **spec-gpu** (L4, 4 CPU, 16 GiB): starts on the first live run (cold start about 1-2 minutes, the page says so),
  is billed per second while the instance exists, then scales back to zero after it has been idle for a while.
  Each live session therefore costs the run itself plus that idle tail.
- Guardrails: the GPU service is private (only the web page's service account may call it), `--max-instances 1`,
  and the page runs one live inspection at a time.

Set a budget alert (alerts notify, they do not stop spending):

```bash
gcloud billing budgets create --billing-account=YOUR_BILLING_ACCOUNT_ID \
  --display-name="spec-to-inspection" --budget-amount=20USD \
  --threshold-rule=percent=0.5 --threshold-rule=percent=1.0
```

After the competition: `./teardown.sh` deletes both services.

## Using an API instead of the GPU service

`spec-web` talks to any OpenAI-compatible chat endpoint. Set `INFER_ENDPOINT` (full `.../chat/completions` URL),
`INFER_AUTH=key`, `INFER_API_KEY`, and `INFER_MODEL`. If the API returns no token log-probabilities, scoring falls
back to the text answer (fixed 0.9 confidence), which is coarser than the recorded results.

## Notes

- If `llama-server` rejects `--reasoning-budget` or `--cache-ram` on the base image's build, `spec-gpu` fails at
  startup; the logs name the flag. Remove it from `gpu/start.sh`, or pin a newer image tag.
- Pin `ghcr.io/ggml-org/llama.cpp:server-cuda` to a specific build tag once it works.
- Data: MVTec LOCO AD pushpins (CC BY-NC-SA 4.0, (c) MVTec Software GmbH), non-commercial use.

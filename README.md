# spec2inspect

**Spec-to-Inspection:** quality checks written in words, not trained on images. Gemma 4 checks every compartment of a box against a written specification; Gemini compiles plain-text specs into rules; Cloud Run, Firestore and Firebase Hosting run the line.

```
browser ──> spec-web (Cloud Run, CPU, public, scales to zero)
              ├─ slideshow / browsing: replays Gemma 4 answers recorded on Kaggle,
              │  re-applies the rules live (pins per compartment, threshold, wall check)
              └─ Live mode: Upload + Inspect your own photo ──> spec-gpu (Cloud Run, 1x L4, private, scales to zero)
```

The GPU runs only when someone presses **Inspect** on an uploaded photo in Live mode. Everything else is CPU.

The line page (`/` on `spec-web`, source layout in `web/README.md`):
- **Replay** (default): boxes slide in, four arms clamp at the camera, the AI pipeline panel shows each step, and the
  diverter sends boxes to GOOD or REJECT, using answers recorded on Kaggle; the written rules are re-applied live.
- **Live** (switch at top right): the left panel becomes a photo tray (sample photos from the public dataset
  `saiphyohein/spec2inspect-images`, served same-origin by `/api/samples`; recorded boxes if it is unavailable),
  and the line header shows **Upload** and **Inspect**. Drag a photo onto the line (or click it, or upload one, which
  also joins the tray). The line holds and places the photo at the camera; **Inspect** sends it to Gemma 4 on
  `spec-gpu` (`POST /api/live/jobs`, then the page polls `GET /api/live/jobs/{id}`), shows and diverts the result,
  and the recorded line continues. Set `SAMPLES_REPO` on `spec-web` to use a different dataset.
- **Check**: every photo inspected live on this device, as cards with the photo and its overlay, the verdict, the
  pins counted per compartment, the findings and the rules that applied; filter by passed or rejected, download
  as CSV. Kept in the browser (last 40), so it survives a reload; the line pauses while Check is open.

## Repository layout

```
.
├── web/          spec-web: line page (public/), live-inspection API, type definitions, unit tests  → web/README.md
├── gpu/          spec-gpu: Gemma 4 E4B on llama.cpp, NVIDIA L4
├── notebooks/    Kaggle notebooks: evaluation (93.8% / 96.3% AUROC), replay recording, live demo
├── deploy.sh · teardown.sh · prepare_replay.sh
└── .gitignore    keeps data, models, node_modules and secrets out of git
```

Recorded results and model weights are not in git or in the web image: `prepare_replay.sh` puts the replay in a
Cloud Storage bucket once, and Cloud Run mounts it read-only into `spec-web`. Each web deploy uploads only the code
(a few hundred KB). The GPU image, with the model inside, is built once and reused (`REBUILD_GPU=1` to rebuild).
Build uploads go to `gs://<project>-build-staging` and are deleted after 7 days.

## 1. Record on Kaggle (free GPUs)

Run `record_replay_kaggle.ipynb` (GPU T4 x2, secret `HF_TOKEN` with write access). It records 40 images x 6
colour/lighting variants, stores every compartment's full answer distribution, prints a robustness table, and
uploads `replay_bundle.tar.gz` to `saiphyohein/loco-zeroshot` (private).

## 2. Deploy (Cloud Shell)

```bash
gcloud config set project YOUR_PROJECT_ID
HF_TOKEN=hf_xxx ./prepare_replay.sh     # once: bundle -> web/replay -> gs://<project>-replay (only changed files upload)
./deploy.sh                             # builds and deploys spec-gpu (private) and spec-web (public)
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
# Spec-to-Inspection: replay page + on-demand GPU

```
browser ──> spec-web (Cloud Run, CPU, public, scales to zero)
              ├─ slideshow / browsing: replays Gemma 4 answers recorded on Kaggle,
              │  re-applies the rules live (pins per compartment, threshold, wall check)
              └─ "Run live" on an uploaded photo only ──> spec-gpu (Cloud Run, 1x L4, private, scales to zero)
```

The GPU runs only when someone presses **Run live** on an upload. Everything else is CPU.

## 1. Record on Kaggle (free GPUs)

Run `record_replay_kaggle.ipynb` (GPU T4 x2, secret `HF_TOKEN` with write access). It records 40 images x 6
colour/lighting variants, stores every compartment's full answer distribution, prints a robustness table, and
uploads `replay_bundle.tar.gz` to `saiphyohein/loco-zeroshot` (private).

## 2. Deploy (Cloud Shell)

```bash
gcloud config set project YOUR_PROJECT_ID
HF_TOKEN=hf_xxx ./prepare_replay.sh     # bundle -> web/replay
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
  --display-name="spec2inspect" --budget-amount=20USD \
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

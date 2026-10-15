# Notebooks

Run on Kaggle in this order. Each notebook is self-contained: it downloads what it needs and installs its tools.
The notebooks here are the actual Kaggle runs, saved **with their outputs**, so the results can be read on GitHub
without re-running anything.

| Notebook | What it does | Produces | Kaggle setup | Time |
|---|---|---|---|---|
| `spec2inspect-evaluate-push-pins.ipynb` | The evaluation behind the reported results: Gemma 4 E4B on the 230 MVTec LOCO **pushpins** test images, rules only, no training images. Every ablation step (yes/no verdict, probability score, smaller questions, one check per compartment, wall geometry) | AUROC table: **93.8%** (Gemma, one check per compartment), **96.3%** (+ wall geometry), and the error analysis of the misses | GPU T4 ×2, internet on, secret `HF_TOKEN` (read) | the longest: several thousand model calls |
| `spec2inspect-record-replay.ipynb` | Records 240 inspections (40 photos × 6 colour/lighting variants) for the line page's Replay mode; robustness, throughput and line coverage | `replay_bundle.tar.gz` (uploaded to Hugging Face), robustness table (99.7–100% of good compartments read correctly), throughput (**16.7 boxes/min**, 3.6 s per box), coverage table, CSVs | GPU T4 ×2, internet on, secret `HF_TOKEN` (write) | 15–60 min |
| `spec2inspect-publish-sample-images.ipynb` | Publishes the public sample photos for the Live tray: good boxes, logical anomalies (incl. missing walls) and colour variants, with a dataset card | [`saiphyohein/spec2inspect-images`](https://huggingface.co/datasets/saiphyohein/spec2inspect-images) (28 photos + `metadata.csv`) | internet on, no GPU, secret `HF_TOKEN` (write) | a few minutes |

**Data:** MVTec LOCO AD (Bergmann et al., IJCV 2022), CC BY-NC-SA 4.0. The source archive is read from a private
Hugging Face dataset; the notebooks never publish the full dataset, only the 28 sample photos (same licence).

**Model:** Google's `gemma-4-E4B-it-qat-q4_0-gguf` (QAT Q4_0 GGUF + vision projector), served with llama.cpp and
orchestrated across the two T4s with [gpu_task_orchestrator](https://github.com/sai-phyo-hein/gpu_task_orchestrator).

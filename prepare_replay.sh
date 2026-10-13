#!/bin/bash
# Downloads the replay bundle recorded on Kaggle (record_replay_kaggle.ipynb) into web/replay.
# Usage:  HF_TOKEN=hf_xxx ./prepare_replay.sh
set -euo pipefail
: "${HF_TOKEN:?set HF_TOKEN (read access to the replay dataset)}"
REPO="${HF_REPO:-saiphyohein/loco-zeroshot}"
curl -fL -H "Authorization: Bearer ${HF_TOKEN}" -o web/replay_bundle.tar.gz \
  "https://huggingface.co/datasets/${REPO}/resolve/main/replay_bundle.tar.gz"
rm -rf web/replay && tar -xzf web/replay_bundle.tar.gz -C web
echo "replay entries: $(ls web/replay/images | wc -l)"

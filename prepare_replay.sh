#!/bin/bash
# Gets the replay recorded on Kaggle (notebooks/spec2inspect-record-replay.ipynb) into web/replay, then syncs it to Cloud Storage.
# Downloads only if web/replay is missing (FORCE=1 to refresh); the sync uploads only new or changed files.
# Usage:  HF_TOKEN=hf_xxx ./prepare_replay.sh
set -euo pipefail
PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:-asia-southeast1}"
REPO="${HF_REPO:-saiphyohein/loco-zeroshot}"
BUCKET="gs://${PROJECT}-replay"

if [ ! -f web/replay/index.json ] || [ "${FORCE:-0}" = "1" ]; then
  : "${HF_TOKEN:?set HF_TOKEN (read access to the replay dataset)}"
  tmp=$(mktemp -d)
  curl -fL -H "Authorization: Bearer ${HF_TOKEN}" -o "$tmp/replay_bundle.tar.gz" \
    "https://huggingface.co/datasets/${REPO}/resolve/main/replay_bundle.tar.gz"
  rm -rf web/replay && tar -xzf "$tmp/replay_bundle.tar.gz" -C web && rm -rf "$tmp"
  echo "downloaded: $(ls web/replay/images | wc -l) images"
else
  echo "web/replay already present ($(ls web/replay/images | wc -l) images); FORCE=1 to download again"
fi

# One bucket holds the replay for Cloud Run (mounted read-only into spec-web). rsync skips unchanged files.
gcloud storage buckets describe "$BUCKET" >/dev/null 2>&1 || \
  gcloud storage buckets create "$BUCKET" --location="$REGION" --uniform-bucket-level-access
gcloud storage rsync web/replay "$BUCKET" --recursive --delete-unmatched-destination-objects
echo "replay synced to $BUCKET"

#!/bin/bash
set -euo pipefail
PARALLEL="${LLAMA_PARALLEL:-16}"
LLAMA_BIN="${LLAMA_BIN:-$(command -v llama-server || echo /app/llama-server)}"
echo "llama.cpp: $("$LLAMA_BIN" --version 2>&1 | grep -iE 'version|build' | head -1)"   # shows in Cloud Run logs
exec "$LLAMA_BIN" \
  --model /models/gemma-4-E4B_q4_0-it.gguf \
  --mmproj /models/gemma-4-E4B-it-mmproj.gguf \
  --n-gpu-layers 99 --flash-attn on \
  --parallel "$PARALLEL" --ctx-size $((2048 * PARALLEL)) \
  --jinja --reasoning-budget 0 --cache-ram 0 \
  -lv "${LLAMA_LOG_VERBOSITY:-3}" \
  --host 0.0.0.0 --port "${PORT:-8080}"
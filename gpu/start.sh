#!/bin/bash
set -euo pipefail
PARALLEL="${LLAMA_PARALLEL:-4}"
LLAMA_BIN="${LLAMA_BIN:-$(command -v llama-server || echo /app/llama-server)}"
exec "$LLAMA_BIN" \
    --model /models/gemma-4-E4B_q4_0-it.gguf \
    --mmproj /models/gemma-4-E4B-it-mmproj.gguf \
    --n-gpu-layers 99 \
    --flash-attn on \
    --parallel "$PARALLEL"  \
    --ctx-size $(( 4096 * PARALLEL )) \
    --jinja \
    --reasoning-budget 0 \
    --cache-ram 0 \
    --host 0.0.0.0 \
    --port "${PORT:-8080}"
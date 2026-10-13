# Gemma 4 E4B inference service: llama.cpp server on Cloud Run with one NVIDIA L4. Private (called by spec-web only).

ARG LLAMA_IMAGE=ghcr.io/ggml-org/llama.cpp:server-cuda
FROM ${LLAMA_IMAGE}
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*

# Google's QAT Q4_0 model and its vision projector, verified against the checksums published on Hugging Face.
RUN mkdir -p /models && cd /models && \
    curl -fL -o gemma-4-E4B_q4_0-it.gguf \
      https://huggingface.co/google/gemma-4-E4B-it-qat-q4_0-gguf/resolve/main/gemma-4-E4B_q4_0-it.gguf && \
    curl -fL -o gemma-4-E4B-it-mmproj.gguf \
      https://huggingface.co/google/gemma-4-E4B-it-qat-q4_0-gguf/resolve/main/gemma-4-E4B-it-mmproj.gguf && \
    printf '%s  %s\n' \
      676c35070db6dbe52f93e9c864ee0fba4eddea94b9c875d9cb10daff453fbaee gemma-4-E4B_q4_0-it.gguf \
      7498a37cb619e55f2fcf87eb931f56e99389ed6d432e4c5c66110694c0d65578 gemma-4-E4B-it-mmproj.gguf \
      | sha256sum -c -

COPY start.sh /start.sh
RUN chmod +x /start.sh && (/app/llama-server --version || llama-server --version || true)   # build number in the build log
ENV PORT=8080 LLAMA_PARALLEL=16
ENTRYPOINT []
CMD ["/start.sh"]
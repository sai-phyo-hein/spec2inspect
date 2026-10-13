# Gemma 4 E4B Inference Service: llama.cpp server on Cloud Run with one NVIDIA L4.
# Private (called by the web page only). 

FROM ghcr.io/ggml-org/llama.cpp:server-cuda
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

RUN mkdir -p /models && \
    curl -fL -o /models/gemma-4-E4B_q4_0-it.gguf \
        https://huggingface.co/google/gemma-4-E2B-it-qat-q4_0-gguf/resolve/main/gemma-4-E2B_q4_0-it.gguf && \
    curl -fL -o /models/gemma-4-E4B-it-mmproj.gguf \
        https://huggingface.co/google/gemma-4-E2B-it-qat-q4_0-gguf/resolve/main/gemma-4-E2B_q4_0-it.gguf

COPY start.sh /start.sh
RUN chmod +x /start.sh
ENV PORT=8080 LLAMA_PARALLEL=4
ENTRYPOINT []
CMD ["/start.sh"]
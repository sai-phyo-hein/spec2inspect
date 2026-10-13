# Spec-to-Inspection web page: CPU only (replay + calls the GPU service for live uploads)
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY spec_core.py app_web.py ./
COPY public ./public
# the replay is not in the image: Cloud Run mounts it read-only from Cloud Storage at /app/replay
ENV PORT=8080 REPLAY_DIR=/app/replay PYTHONUNBUFFERED=1
CMD ["python", "app_web.py"]

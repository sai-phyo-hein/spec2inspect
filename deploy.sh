#!/bin/bash
# Two Cloud Run services:
#   spec-gpu  private, 1x L4, scales to zero; only the web page's service account may call it
#   spec-web  public, CPU only, replays the Kaggle recording; calls spec-gpu only for "Run live" on an upload
set -euo pipefail
PROJECT="${PROJECT:-$(gcloud config get-value project)}"
REGION="${REGION:-asia-southeast1}"
REPO="${REPO:-spec-to-inspection}"
AR="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}"
WEB_SA="spec-web@${PROJECT}.iam.gserviceaccount.com"
DEPLOY_GPU="${DEPLOY_GPU:-1}"          # set DEPLOY_GPU=0 for a replay-only page (no live uploads, no GPU cost)

[ -f web/replay/index.json ] || { echo "run ./prepare_replay.sh first"; exit 1; }
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com iam.googleapis.com
gcloud artifacts repositories describe "$REPO" --location "$REGION" >/dev/null 2>&1 || \
  gcloud artifacts repositories create "$REPO" --repository-format docker --location "$REGION"
gcloud iam service-accounts describe "$WEB_SA" >/dev/null 2>&1 || \
  gcloud iam service-accounts create spec-web --display-name "Spec-to-Inspection web page"

ENV_VARS="INFER_AUTH=none"
if [ "$DEPLOY_GPU" = "1" ]; then
  gcloud builds submit gpu --tag "$AR/spec-gpu:latest" --machine-type e2-highcpu-8 --timeout 3600s
  gcloud run deploy spec-gpu --image "$AR/spec-gpu:latest" --region "$REGION" \
    --gpu 1 --gpu-type nvidia-l4 --no-gpu-zonal-redundancy \
    --cpu 4 --memory 16Gi --no-cpu-throttling \
    --min-instances 0 --max-instances 1 --concurrency 4 --timeout 600 \
    --port 8080 --no-allow-unauthenticated
  gcloud run services add-iam-policy-binding spec-gpu --region "$REGION" \
    --member "serviceAccount:${WEB_SA}" --role roles/run.invoker
  GPU_URL=$(gcloud run services describe spec-gpu --region "$REGION" --format 'value(status.url)')
  ENV_VARS="INFER_ENDPOINT=${GPU_URL}/v1/chat/completions,INFER_AUTH=google"
fi

gcloud builds submit web --tag "$AR/spec-web:latest" --timeout 1800s
gcloud run deploy spec-web --image "$AR/spec-web:latest" --region "$REGION" \
  --service-account "$WEB_SA" --cpu 1 --memory 2Gi \
  --min-instances 0 --max-instances 2 --timeout 3600 --session-affinity \
  --set-env-vars "$ENV_VARS" --port 8080 --allow-unauthenticated

echo "Web page: $(gcloud run services describe spec-web --region "$REGION" --format 'value(status.url)')"

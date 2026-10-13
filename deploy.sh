#!/bin/bash
# Two Cloud Run services:
#   spec-gpu  private, 1x L4, scales to zero; only the web page's service account may call it
#   spec-web  public, CPU only, replays the Kaggle recording; calls spec-gpu only when an uploaded photo is inspected
set -euo pipefail
PROJECT="${PROJECT:-$(gcloud config get-value project)}"
REGION="${REGION:-asia-southeast1}"
REPO="${REPO:-spec-to-inspection}"
AR="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}"
WEB_SA="spec-web@${PROJECT}.iam.gserviceaccount.com"
DEPLOY_GPU="${DEPLOY_GPU:-1}"          # set DEPLOY_GPU=0 for a replay-only page (no live uploads, no GPU cost)
REBUILD_GPU="${REBUILD_GPU:-0}"        # the GPU image (model inside) is built once; REBUILD_GPU=1 to rebuild it
REPLAY_BUCKET="${PROJECT}-replay"      # filled by ./prepare_replay.sh, mounted read-only into spec-web
STAGING="gs://${PROJECT}-build-staging"

gcloud storage objects describe "gs://${REPLAY_BUCKET}/index.json" >/dev/null 2>&1 || \
  { echo "replay not in gs://${REPLAY_BUCKET}: run ./prepare_replay.sh first"; exit 1; }
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com iam.googleapis.com compute.googleapis.com

# Builds run as the Compute Engine default service account on newer projects: give it what a build needs.
PNUM=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
BUILD_SA="${PNUM}-compute@developer.gserviceaccount.com"
for ROLE in roles/cloudbuild.builds.builder roles/storage.objectAdmin roles/artifactregistry.writer roles/logging.logWriter; do
  gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:${BUILD_SA}" --role="$ROLE" --condition=None -q >/dev/null
done
# Build sources are staged in our own bucket; old uploads are deleted after 7 days so they don't pile up.
if ! gcloud storage buckets describe "$STAGING" >/dev/null 2>&1; then
  gcloud storage buckets create "$STAGING" --location="$REGION" --uniform-bucket-level-access
  printf '{"rule":[{"action":{"type":"Delete"},"condition":{"age":7}}]}' > /tmp/staging-lifecycle.json
  gcloud storage buckets update "$STAGING" --lifecycle-file=/tmp/staging-lifecycle.json
fi
BUILD_FLAGS=(--gcs-source-staging-dir "${STAGING}/source" --gcs-log-dir "${STAGING}/logs")

gcloud artifacts repositories describe "$REPO" --location "$REGION" >/dev/null 2>&1 || \
  gcloud artifacts repositories create "$REPO" --repository-format docker --location "$REGION"
gcloud iam service-accounts describe "$WEB_SA" >/dev/null 2>&1 || \
  gcloud iam service-accounts create spec-web --display-name "Spec-to-Inspection web page"
gcloud storage buckets add-iam-policy-binding "gs://${REPLAY_BUCKET}" \
  --member "serviceAccount:${WEB_SA}" --role roles/storage.objectViewer -q >/dev/null

ENV_VARS="INFER_AUTH=none"
if [ "$DEPLOY_GPU" = "1" ]; then
  if [ "$REBUILD_GPU" = "1" ] || ! gcloud artifacts docker images describe "$AR/spec-gpu:latest" >/dev/null 2>&1; then
    gcloud builds submit gpu --tag "$AR/spec-gpu:latest" --machine-type e2-highcpu-8 --timeout 3600s "${BUILD_FLAGS[@]}"
  else
    echo "spec-gpu image already built; skipping (REBUILD_GPU=1 to rebuild)"
  fi
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

gcloud builds submit web --tag "$AR/spec-web:latest" --timeout 1800s "${BUILD_FLAGS[@]}"   # code only: a few hundred KB
gcloud run deploy spec-web --image "$AR/spec-web:latest" --region "$REGION" \
  --service-account "$WEB_SA" --cpu 1 --memory 2Gi --execution-environment gen2 \
  --add-volume "name=replay,type=cloud-storage,bucket=${REPLAY_BUCKET},readonly=true" \
  --add-volume-mount "volume=replay,mount-path=/app/replay" \
  --min-instances 0 --max-instances 1 --timeout 3600 --session-affinity \
  --set-env-vars "$ENV_VARS" --port 8080 --allow-unauthenticated

echo "Web page: $(gcloud run services describe spec-web --region "$REGION" --format 'value(status.url)')"

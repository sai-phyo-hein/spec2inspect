#!/bin/bash
# Checks that a Gemini model can be called from this project on Vertex AI (global endpoint) before deploying.
# Usage: ./check_planner_model.sh [model]      e.g. ./check_planner_model.sh gemini-3.5-pro
set -euo pipefail
PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
MODEL="${1:-gemini-3.5-pro}"
gcloud services enable aiplatform.googleapis.com --project "$PROJECT" >/dev/null
out=$(curl -s -H "Authorization: Bearer $(gcloud auth print-access-token)" -H "Content-Type: application/json" \
  "https://aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/global/publishers/google/models/${MODEL}:generateContent" \
  -d '{"contents":[{"role":"user","parts":[{"text":"Reply with the single word OK."}]}]}')
if echo "$out" | grep -q '"candidates"'; then
  echo "OK: ${MODEL} is callable from ${PROJECT}. Deploy with PLANNER_MODELS=${MODEL} ./deploy.sh"
else
  echo "NOT AVAILABLE: ${MODEL}"; echo "$out" | head -c 600; echo
  echo "Try another model, e.g. ./check_planner_model.sh gemini-3.5-flash"
  exit 1
fi

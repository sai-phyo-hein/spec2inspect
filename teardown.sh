#!/bin/bash
# Delete both services after the competition (stops all Cloud Run charges for this demo).
REGION="${REGION:-asia-southeast1}"
gcloud run services delete spec-web --region "$REGION" --quiet || true
gcloud run services delete spec-gpu --region "$REGION" --quiet || true

#!/bin/bash
# Firebase Hosting for the line page (web/public) + Firestore security rules.
# /api/** and /replay/** are forwarded to the spec-web Cloud Run service (see firebase.json).
# First time only:  npx firebase-tools@15.32.1 login --no-localhost
#                   npx firebase-tools@15.32.1 projects:addfirebase spec2inspect
set -euo pipefail
PROJECT="${PROJECT:-$(gcloud config get-value project)}"
FIREBASE="npx --yes firebase-tools@15.32.1"
$FIREBASE deploy --only hosting,firestore:rules --project "$PROJECT"
echo "Line page: https://${PROJECT}.web.app"

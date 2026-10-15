#!/bin/bash
# Firebase Hosting for the line page (web/public) + Firestore security rules.
# /api/** and /replay/** are forwarded to the spec-web Cloud Run service (see firebase.json).
# First time only:  npx firebase-tools@15.32.1 login --no-localhost
set -euo pipefail
PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
SITE="${SITE:-$PROJECT}"                       # must match "site" in firebase.json
FIREBASE="npx --yes firebase-tools@15.32.1"

# Firebase must be enabled on the project, and the Hosting site must exist (both only once).
$FIREBASE projects:list 2>/dev/null | grep -q "$PROJECT" || $FIREBASE projects:addfirebase "$PROJECT"
$FIREBASE hosting:sites:list --project "$PROJECT" 2>/dev/null | grep -q "$SITE" || \
  $FIREBASE hosting:sites:create "$SITE" --project "$PROJECT"

$FIREBASE deploy --only hosting,firestore:rules --project "$PROJECT"
echo "Line page: https://${SITE}.web.app"
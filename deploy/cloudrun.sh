#!/usr/bin/env bash
# Deploy xyte to Google Cloud Run from this repo's Dockerfile.
#   PROJECT=my-project REGION=us-central1 ./deploy/cloudrun.sh
# Secrets live in Secret Manager; create them once:
#   printf %s "$OXYLABS_PASSWORD" | gcloud secrets create oxylabs-password --data-file=-
#   printf %s "$(openssl rand -hex 24)" | gcloud secrets create xyte-api-keys --data-file=-
set -euo pipefail
: "${PROJECT:?set PROJECT}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-xyte}"

# --source builds the Dockerfile with Cloud Build (full image: HTTP + browser).
# gen2 + 2 GiB: Chromium needs a real /dev/shm and memory. --concurrency matches XYTE_CONCURRENCY
# so Cloud Run scales out instead of queueing inside one instance.
# The "^@^" prefix makes "@" the separator, because XYTE_PROVIDER values may contain commas.
gcloud run deploy "$SERVICE" \
  --project "$PROJECT" --region "$REGION" \
  --source . \
  --execution-environment gen2 \
  --cpu 2 --memory 2Gi \
  --concurrency 8 --timeout 300 \
  --min-instances 0 --max-instances 20 \
  --allow-unauthenticated \
  --set-env-vars "^@^XYTE_PROVIDER=oxylabs@OXYLABS_USERNAME=${OXYLABS_USERNAME:?set OXYLABS_USERNAME}@XYTE_CONCURRENCY=8@XYTE_BLOCK_RESOURCES=image,media,font" \
  --set-secrets "OXYLABS_PASSWORD=oxylabs-password:latest,XYTE_API_KEYS=xyte-api-keys:latest"

# "--allow-unauthenticated" exposes the URL publicly; XYTE_API_KEYS is what protects it, the same
# way a Zyte API key does. For internal-only use, drop it and call with an identity token instead.
gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format 'value(status.url)'

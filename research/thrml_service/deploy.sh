#!/usr/bin/env bash
# Build + deploy the private THRML sampler Cloud Run service. Idempotent.
#   research/thrml_service/deploy.sh
set -euo pipefail
cd "$(dirname "$0")"
export CLOUDSDK_CORE_ACCOUNT=${CLOUDSDK_CORE_ACCOUNT:-jacobfv123@gmail.com}
P=${GOOGLE_CLOUD_PROJECT:-jacobfv123-main-project}
R=${REGION:-us-central1}
G="gcloud --project $P --quiet"
SA=cortex2-api@$P.iam.gserviceaccount.com
SHA=$(git rev-parse --short HEAD)$(git diff --quiet -- . || echo -dirty)
IMAGE=$R-docker.pkg.dev/$P/cortex2/thrml-sampler:$SHA-$(date +%s)

echo "▸ build $IMAGE"
$G builds submit --tag "$IMAGE" --machine-type=e2-highcpu-8 .

# Regional quotas: 20 vCPU / 40 GiB; the main app uses up to 16 vCPU / 32 GiB → 1 × (4 vCPU, 8 GiB) fits exactly.
echo "▸ deploy thrml-sampler"
$G run deploy thrml-sampler --image "$IMAGE" --region $R --no-allow-unauthenticated \
  --cpu 4 --memory ${MEMORY:-8Gi} --concurrency 4 --min-instances 0 --max-instances 1 --timeout 600 \
  --service-account "$SA" --set-env-vars JAX_PLATFORMS=cpu

echo "▸ grant run.invoker"
for m in "serviceAccount:$SA" ${EXTRA_INVOKERS:-user:jacobfv123@gmail.com}; do
  $G run services add-iam-policy-binding thrml-sampler --region $R --member "$m" --role roles/run.invoker >/dev/null
done
URL=$($G run services describe thrml-sampler --region $R --format='value(status.url)')
echo "▸ $URL  (set THRML_SERVICE_URL=$URL in .env)"

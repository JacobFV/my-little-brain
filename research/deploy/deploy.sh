#!/usr/bin/env bash
# cortex² → Google Cloud (Cloud Run ×2, Firestore, Cloud Tasks, Cloud Scheduler, Secret Manager, GCS).
# Idempotent: safe to re-run after changing code or research/.env.
#   research/deploy/deploy.sh            build + deploy
#   SKIP_BUILD=1 research/deploy/deploy.sh   redeploy config/secrets with the last image
set -euo pipefail
cd "$(dirname "$0")/../.."
set -a; source research/.env; set +a

P=${GOOGLE_CLOUD_PROJECT:?set GOOGLE_CLOUD_PROJECT in research/.env}
R=${REGION:-us-central1}
G="gcloud --project $P --quiet"
NUM=$($G projects describe "$P" --format='value(projectNumber)')
API_SA=cortex2-api@$P.iam.gserviceaccount.com
TASK_SA=cortex2-tasks@$P.iam.gserviceaccount.com
BUCKET=${ARTIFACT_BUCKET:-$P-cortex2-artifacts}
QUEUE=${TASK_QUEUE:-cortex2-work}
WORKER_URL=https://cortex2-worker-$NUM.$R.run.app
PUBLIC_URL=https://cortex2-$NUM.$R.run.app
VERSION=$(git rev-parse --short HEAD)$(git diff --quiet || echo -dirty)
IMAGE=$R-docker.pkg.dev/$P/cortex2/cortex2:$VERSION-$(date +%s)

echo "▸ project $P ($NUM) region $R"
$G services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com firestore.googleapis.com \
  cloudtasks.googleapis.com secretmanager.googleapis.com cloudscheduler.googleapis.com storage.googleapis.com iam.googleapis.com >/dev/null

# ---- one-time infrastructure (each step tolerates "already exists")
$G firestore databases describe --database='(default)' >/dev/null 2>&1 || \
  $G firestore databases create --database='(default)' --location=nam5 --type=firestore-native
$G artifacts repositories describe cortex2 --location=$R >/dev/null 2>&1 || \
  $G artifacts repositories create cortex2 --repository-format=docker --location=$R
$G tasks queues describe $QUEUE --location=$R >/dev/null 2>&1 || \
  $G tasks queues create $QUEUE --location=$R --max-attempts=3 --min-backoff=10s --max-concurrent-dispatches=8
$G storage buckets describe gs://$BUCKET >/dev/null 2>&1 || \
  $G storage buckets create gs://$BUCKET --location=$R --uniform-bucket-level-access
for sa in cortex2-api cortex2-tasks; do
  $G iam service-accounts describe $sa@$P.iam.gserviceaccount.com >/dev/null 2>&1 || \
    $G iam service-accounts create $sa --display-name="cortex2 $sa"
done
for role in roles/datastore.user roles/cloudtasks.enqueuer roles/secretmanager.secretAccessor roles/logging.logWriter; do
  $G projects add-iam-policy-binding $P --member=serviceAccount:$API_SA --role=$role --condition=None >/dev/null
done
$G iam service-accounts add-iam-policy-binding $TASK_SA --member=serviceAccount:$API_SA --role=roles/iam.serviceAccountUser >/dev/null
$G storage buckets add-iam-policy-binding gs://$BUCKET --member=serviceAccount:$API_SA --role=roles/storage.objectAdmin >/dev/null

# ---- secrets (only non-empty values are pushed; Cloud Run reads :latest)
SECRET_FLAGS=()
for name in GEMINI_API_KEY GEMINI_API_KEY_B GEMINI_API_KEY_C GEMINI_API_KEY_D GEMINI_API_KEY_E OPENAI_API_KEY IBM_QUANTUM_TOKEN IONQ_API_KEY; do
  val=${!name:-}
  if [[ -n "$val" ]]; then
    $G secrets describe $name >/dev/null 2>&1 || $G secrets create $name --replication-policy=automatic >/dev/null
    printf '%s' "$val" | $G secrets versions add $name --data-file=- >/dev/null
  fi
  if $G secrets describe $name >/dev/null 2>&1; then SECRET_FLAGS+=("$name=$name:latest"); fi
done
SECRETS=$(IFS=,; echo "${SECRET_FLAGS[*]:-}")

# ---- build
if [[ -z "${SKIP_BUILD:-}" ]]; then
  echo "▸ building $IMAGE"
  $G builds submit --config research/deploy/cloudbuild.yaml \
    --substitutions=_IMAGE=$IMAGE,_GOOGLE_CLIENT_ID=${GOOGLE_OAUTH_CLIENT_ID:-},_VERSION=$VERSION .
else
  IMAGE=${IMAGE_OVERRIDE:-$($G run services describe cortex2 --region $R --format="value(spec.template.spec.containers[0].image)")}
fi

ENV="GOOGLE_CLOUD_PROJECT=$P,REGION=$R,TASK_QUEUE=$QUEUE,WORKER_URL=$WORKER_URL,TASK_SERVICE_ACCOUNT=$TASK_SA,ARTIFACT_BUCKET=$BUCKET"
ENV="$ENV,GOOGLE_OAUTH_CLIENT_ID=${GOOGLE_OAUTH_CLIENT_ID:-},GEMINI_MODEL=${GEMINI_MODEL:-gemini-4-argon},OPENAI_MODEL=${OPENAI_MODEL:-gpt-6.1-sol},IBM_QUANTUM_INSTANCE=${IBM_QUANTUM_INSTANCE:-},IBM_BACKEND=${IBM_BACKEND:-},IONQ_QPU_BACKEND=${IONQ_QPU_BACKEND:-qpu.aria-1},IONQ_NOISE_MODEL=${IONQ_NOISE_MODEL:-aria-1}"
ENV="$ENV,AGENT_REASONING_EFFORT=${AGENT_REASONING_EFFORT:-},CORS_ORIGINS="
ENVFILE=$(mktemp); trap 'rm -f $ENVFILE' EXIT
python3 - "$ENV" "${ALLOWED_EMAILS:-}" "${AGENT_PROVIDERS:-gemini:GEMINI_API_KEY}" > "$ENVFILE" <<'PY'
import sys, json
pairs = dict(kv.split("=", 1) for kv in sys.argv[1].split(","))
pairs["ALLOWED_EMAILS"] = sys.argv[2]
pairs["AGENT_PROVIDERS"] = sys.argv[3]
print("\n".join(f"{k}: {json.dumps(v)}" for k, v in pairs.items()))
PY
SECRET_ARG=(); [[ -n "$SECRETS" ]] && SECRET_ARG=(--set-secrets "$SECRETS")

echo "▸ deploying worker"
$G run deploy cortex2-worker --image "$IMAGE" --region $R --service-account $API_SA \
  --no-allow-unauthenticated --cpu 2 --memory 4Gi --concurrency 4 --timeout 1800 --max-instances 4 \
  --env-vars-file "$ENVFILE" ${SECRET_ARG[@]+"${SECRET_ARG[@]}"} >/dev/null
$G run services add-iam-policy-binding cortex2-worker --region $R --member=serviceAccount:$TASK_SA --role=roles/run.invoker >/dev/null

echo "▸ deploying public service"
$G run deploy cortex2 --image "$IMAGE" --region $R --service-account $API_SA \
  --allow-unauthenticated --cpu 1 --memory 2Gi --concurrency 40 --timeout 300 --min-instances 1 --max-instances 6 \
  --env-vars-file "$ENVFILE" ${SECRET_ARG[@]+"${SECRET_ARG[@]}"} >/dev/null

echo "▸ heartbeat schedule"
if $G scheduler jobs describe cortex2-heartbeat --location $R >/dev/null 2>&1; then verb=update; else verb=create; fi
$G scheduler jobs $verb http cortex2-heartbeat --location $R --schedule "*/5 * * * *" \
  --uri "$WORKER_URL/internal/heartbeat" --http-method POST \
  --oidc-service-account-email $TASK_SA --oidc-token-audience "$WORKER_URL" >/dev/null

echo
echo "✓ cortex² is live:  $PUBLIC_URL"
curl -fsS "$PUBLIC_URL/health" && echo
[[ -z "${GOOGLE_OAUTH_CLIENT_ID:-}" ]] && echo "! sign-in disabled until GOOGLE_OAUTH_CLIENT_ID is set (authorized JavaScript origin: $PUBLIC_URL)"
[[ -z "${GEMINI_API_KEY:-}${OPENAI_API_KEY:-}" ]] && echo "! agent disabled until a model key (GEMINI_API_KEY / AGENT_PROVIDERS) is set"
[[ -z "${IBM_QUANTUM_TOKEN:-}" ]] && ! $G secrets describe IBM_QUANTUM_TOKEN >/dev/null 2>&1 && echo "! IBM QPU disabled until IBM_QUANTUM_TOKEN is set"
exit 0

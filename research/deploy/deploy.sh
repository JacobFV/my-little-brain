#!/usr/bin/env bash
# cortex² → Google Cloud (Cloud Run ×2, Firestore, Cloud Tasks, Cloud Scheduler, Secret Manager, GCS).
# Idempotent: safe to re-run after changing code or .env. See research/deploy/README.md.
#   research/deploy/deploy.sh                build + deploy
#   SKIP_BUILD=1 research/deploy/deploy.sh   redeploy config/secrets with the currently deployed image
set -euo pipefail
cd "$(dirname "$0")/../.."
[[ -f .env ]] || { echo ".env missing (see research/deploy/README.md)"; exit 1; }
set -a; source .env; set +a

P=${GOOGLE_CLOUD_PROJECT:?set GOOGLE_CLOUD_PROJECT in .env}
R=${REGION:-us-central1}
G="gcloud --project $P --quiet"
NUM=$($G projects describe "$P" --format='value(projectNumber)')
API_SA=cortex2-api@$P.iam.gserviceaccount.com
TASK_SA=cortex2-tasks@$P.iam.gserviceaccount.com
BUCKET=${ARTIFACT_BUCKET:-$P-cortex2-artifacts}
QUEUE=${TASK_QUEUE:-cortex2-work}
SERVICE=${SERVICE_NAME:-my-little-brain}
PUBLIC_URL=https://$SERVICE-$NUM.$R.run.app
WORKER_URL=$PUBLIC_URL        # one service: Cloud Tasks call back into it (OIDC-verified /internal/*)
VERSION=$(git rev-parse --short HEAD)$(git diff --quiet || echo -dirty)
IMAGE=$R-docker.pkg.dev/$P/cortex2/cortex2:$VERSION-$(date +%s)
# One service sized to the default 20-vCPU regional Cloud Run quota: 4 vCPU × ≤4 instances.
CPU=${CPU:-4};  MEMORY=${MEMORY:-8Gi};  MIN=${MIN_INSTANCES:-1};  MAX=${MAX_INSTANCES:-4}

echo "▸ project $P ($NUM) region $R"
$G services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com firestore.googleapis.com \
  cloudtasks.googleapis.com secretmanager.googleapis.com cloudscheduler.googleapis.com storage.googleapis.com iam.googleapis.com >/dev/null

# ---- infrastructure (each step tolerates "already exists")
$G firestore databases describe --database='(default)' >/dev/null 2>&1 || \
  $G firestore databases create --database='(default)' --location=nam5 --type=firestore-native
$G artifacts repositories describe cortex2 --location=$R >/dev/null 2>&1 || \
  $G artifacts repositories create cortex2 --repository-format=docker --location=$R
QUEUE_FLAGS=(--max-attempts=5 --min-backoff=10s --max-backoff=300s --max-concurrent-dispatches=8 --max-dispatches-per-second=5)
if $G tasks queues describe $QUEUE --location=$R >/dev/null 2>&1; then
  $G tasks queues update $QUEUE --location=$R "${QUEUE_FLAGS[@]}" >/dev/null
else
  $G tasks queues create $QUEUE --location=$R "${QUEUE_FLAGS[@]}" >/dev/null
fi
$G storage buckets describe gs://$BUCKET >/dev/null 2>&1 || \
  $G storage buckets create gs://$BUCKET --location=$R --uniform-bucket-level-access --public-access-prevention
for sa in cortex2-api cortex2-tasks; do
  $G iam service-accounts describe $sa@$P.iam.gserviceaccount.com >/dev/null 2>&1 || \
    $G iam service-accounts create $sa --display-name="cortex2 $sa"
done
for role in roles/datastore.user roles/cloudtasks.enqueuer roles/secretmanager.secretAccessor roles/logging.logWriter; do
  $G projects add-iam-policy-binding $P --member=serviceAccount:$API_SA --role=$role --condition=None >/dev/null
done
$G iam service-accounts add-iam-policy-binding $TASK_SA --member=serviceAccount:$API_SA --role=roles/iam.serviceAccountUser >/dev/null
$G storage buckets add-iam-policy-binding gs://$BUCKET --member=serviceAccount:$API_SA --role=roles/storage.objectAdmin >/dev/null

# Firestore TTL: expired device tokens, stale live-EEG docs and old quota windows are deleted automatically.
for coll in ingest_tokens eeg_streams quotas; do
  $G firestore fields ttls update expire_at --collection-group=$coll --enable-ttl --async >/dev/null 2>&1 || \
    echo "  (TTL policy for $coll not updated; it may already be enabled)"
done

# ---- secrets: a new version is added only when the value changed; Cloud Run reads :latest
SECRET_FLAGS=()
for name in GEMINI_API_KEY GEMINI_API_KEY_B GEMINI_API_KEY_C GEMINI_API_KEY_D GEMINI_API_KEY_E OPENAI_API_KEY IBM_QUANTUM_TOKEN IONQ_API_KEY QBRAID_API_KEY GOOGLE_OAUTH_CLIENT_SECRET; do
  val=${!name:-}
  if [[ -n "$val" ]]; then
    if ! $G secrets describe $name >/dev/null 2>&1; then
      $G secrets create $name --replication-policy=automatic >/dev/null
    fi
    current=$($G secrets versions access latest --secret=$name 2>/dev/null || true)
    if [[ "$current" != "$val" ]]; then
      printf '%s' "$val" | $G secrets versions add $name --data-file=- >/dev/null
      echo "  secret $name updated"
    fi
  fi
  if $G secrets describe $name >/dev/null 2>&1; then SECRET_FLAGS+=("$name=$name:latest"); fi
done
SECRETS=$(IFS=,; echo "${SECRET_FLAGS[*]:-}")
SECRET_ARG=(); [[ -n "$SECRETS" ]] && SECRET_ARG=(--set-secrets "$SECRETS")

# ---- build (the OAuth client id is baked into the web bundle, so changing it requires a build)
if [[ -z "${SKIP_BUILD:-}" ]]; then
  echo "▸ building $IMAGE"
  $G builds submit --config research/deploy/cloudbuild.yaml \
    --substitutions="_IMAGE=$IMAGE,_GOOGLE_CLIENT_ID=${GOOGLE_OAUTH_CLIENT_ID:-},_VERSION=$VERSION" .
else
  IMAGE=${IMAGE_OVERRIDE:-$($G run services describe $SERVICE --region $R --format="value(spec.template.spec.containers[0].image)")}
  deployed_client=$($G run services describe $SERVICE --region $R --format=json 2>/dev/null | python3 -c '
import json, sys
env = json.load(sys.stdin)["spec"]["template"]["spec"]["containers"][0].get("env", [])
print(next((e.get("value", "") for e in env if e["name"] == "GOOGLE_OAUTH_CLIENT_ID"), ""))' || true)
  if [[ "${deployed_client}" != "${GOOGLE_OAUTH_CLIENT_ID:-}" ]]; then
    echo "! GOOGLE_OAUTH_CLIENT_ID changed since the last build; the web bundle would be stale. Re-run without SKIP_BUILD."
    exit 1
  fi
fi

# ---- runtime environment (written by name so values may contain commas)
ENVFILE=$(mktemp); trap 'rm -f "$ENVFILE" "$ENVFILE".*' EXIT
export GOOGLE_CLOUD_PROJECT=$P REGION=$R TASK_QUEUE=$QUEUE WORKER_URL TASK_SERVICE_ACCOUNT=$TASK_SA ARTIFACT_BUCKET=$BUCKET
export GEMINI_MODEL=${GEMINI_MODEL:-gemini-4-argon} OPENAI_MODEL=${OPENAI_MODEL:-gpt-6.1-sol}
export AGENT_PROVIDERS=${AGENT_PROVIDERS:-gemini:GEMINI_API_KEY}
export IONQ_QPU_BACKEND=${IONQ_QPU_BACKEND:-qpu.forte-1} IONQ_NOISE_MODEL=${IONQ_NOISE_MODEL:-forte-1}
python3 - "$ENVFILE" <<'PY'
import json, os, sys
names = ["GOOGLE_CLOUD_PROJECT", "REGION", "TASK_QUEUE", "WORKER_URL", "TASK_SERVICE_ACCOUNT", "ARTIFACT_BUCKET",
         "GOOGLE_OAUTH_CLIENT_ID", "ALLOWED_EMAILS", "HARDWARE_EMAILS", "AGENT_PROVIDERS", "GEMINI_MODEL", "OPENAI_MODEL",
         "AGENT_REASONING_EFFORT", "IBM_QUANTUM_INSTANCE", "IBM_BACKEND", "IONQ_QPU_BACKEND", "IONQ_NOISE_MODEL", "QBRAID_SIM_DEVICE", "QBRAID_QPU_DEVICE", "THRML_SERVICE_URL",
         "MAX_BODY_BYTES", "CAP_QPU_JOBS", "INGEST_MIN_INTERVAL", "LOG_LEVEL"]
names += sorted(k for k in os.environ if k.startswith("LIMIT_"))
env = {k: os.environ.get(k, "") for k in names}
env["CORS_ORIGINS"] = ""            # same-origin in production
with open(sys.argv[1], "w") as fh:
    fh.write("\n".join(f"{k}: {json.dumps(v)}" for k, v in {**env, "SERVICE_ROLE": "all"}.items()) + "\n")
PY

echo "▸ retiring the legacy two-service layout (frees CPU quota)"
for old in cortex2-worker cortex2; do
  $G run services describe $old --region $R >/dev/null 2>&1 && $G run services delete $old --region $R >/dev/null && echo "  deleted $old"
done
$G scheduler jobs describe cortex2-heartbeat --location $R >/dev/null 2>&1 && $G scheduler jobs delete cortex2-heartbeat --location $R >/dev/null

echo "▸ deploying $SERVICE (${CPU} vCPU × ${MIN}–${MAX})"
$G run deploy $SERVICE --image "$IMAGE" --region $R --service-account $API_SA \
  --allow-unauthenticated --cpu "$CPU" --memory "$MEMORY" --concurrency 8 --timeout 1800 \
  --min-instances "$MIN" --max-instances "$MAX" --cpu-boost --no-cpu-throttling \
  --env-vars-file "$ENVFILE" ${SECRET_ARG[@]+"${SECRET_ARG[@]}"} >/dev/null
$G run services add-iam-policy-binding $SERVICE --region $R --member=serviceAccount:$TASK_SA --role=roles/run.invoker >/dev/null

echo "▸ removing the retired heartbeat schedule (if any)"
$G scheduler jobs describe my-little-brain-heartbeat --location $R >/dev/null 2>&1 && $G scheduler jobs delete my-little-brain-heartbeat --location $R --quiet >/dev/null || true

echo
echo "✓ My Little Brain deployed:  $PUBLIC_URL   (image $IMAGE)"
if health=$(curl -fsS --retry 3 --retry-delay 5 "$PUBLIC_URL/health"); then echo "  health: $health"; else echo "! health check failed (service may still be starting)"; fi
if [[ -z "${GOOGLE_OAUTH_CLIENT_ID:-}" ]]; then
  cat <<EOF
! Sign-in is disabled until GOOGLE_OAUTH_CLIENT_ID is set:
    Console → APIs & Services → Credentials → Create credentials → OAuth client ID → Web application
    Authorized JavaScript origins:  $PUBLIC_URL   and   http://127.0.0.1:5173
    Put the client id in .env as GOOGLE_OAUTH_CLIENT_ID=… and re-run this script (a rebuild is required).
EOF
fi
[[ -z "${ALLOWED_EMAILS:-}" ]] && echo "! ALLOWED_EMAILS is empty: any verified Google account can sign in (quotas still apply)."
[[ -z "${HARDWARE_EMAILS:-}" ]] && echo "! HARDWARE_EMAILS is empty: every signed-in user may submit to paid QPUs (capped by LIMIT_HARDWARE_JOB)."
[[ -z "${GEMINI_API_KEY:-}${OPENAI_API_KEY:-}" ]] && echo "! agent disabled until a model key (GEMINI_API_KEY / AGENT_PROVIDERS) is set"
exit 0

# Deploying cortex² to Google Cloud

`research/deploy/deploy.sh` is idempotent: every run reconciles infrastructure, secrets, both Cloud
Run services and the scheduler with `research/.env`. Run it as a project owner:

```bash
gcloud auth login && gcloud auth application-default login
research/deploy/deploy.sh                    # build (Cloud Build) + deploy, about 10 min
SKIP_BUILD=1 research/deploy/deploy.sh       # config / secrets only, reusing the deployed image
```

## What it provisions

| resource | notes |
|---|---|
| Cloud Run `cortex2` | public. Serves `/v1` and the `/lab` web app on the same origin. `SERVICE_ROLE=api`, so `/internal/*` returns 404 |
| Cloud Run `cortex2-worker` | private (`--no-allow-unauthenticated`). Only the `cortex2-tasks` identity may invoke it. `SERVICE_ROLE=worker` |
| Cloud Tasks `cortex2-work` | job execution and provider polling. Tasks carry OIDC tokens that the worker verifies (audience + email) |
| Cloud Scheduler `cortex2-heartbeat` | every 5 min: re-polls stale QPU jobs, fails stuck ones, wakes autopilot operators |
| Firestore (native) | documents. Nested arrays are encoded transparently, documents are size-checked, and TTL is set on `expire_at` for `ingest_tokens`, `eeg_streams`, `quotas` |
| GCS bucket | rendered figures, snapshots, OpenBCI recordings, offloaded oversized job fields. Uniform access, public access prevented |
| Secret Manager | model, IBM and IonQ keys. A new version is added only when the value changes |
| service accounts | `cortex2-api` runs both services (Firestore, Tasks enqueue, secrets, bucket). `cortex2-tasks` signs task and scheduler requests |

The default sizing fits the default 20-vCPU regional quota: worker 2 vCPU × 4 instances plus
public 1 vCPU × 6 instances. Override it with `WORKER_CPU`, `WORKER_MEMORY`, `WORKER_MAX_INSTANCES`,
`PUBLIC_CPU`, `PUBLIC_MEMORY`, `PUBLIC_MIN_INSTANCES` and `PUBLIC_MAX_INSTANCES`.

## Sign-in (one manual step)

1. In Console → APIs & Services → Credentials, choose **Create credentials → OAuth client ID → Web application**.
2. Under **Authorized JavaScript origins**, add `https://cortex2-<project-number>.<region>.run.app` and `http://127.0.0.1:5173`.
3. Set `GOOGLE_OAUTH_CLIENT_ID=…` in `research/.env` and run the script **with** a build. The ID is
   baked into the web bundle, so a `SKIP_BUILD` run refuses to proceed if it would be stale.

## Access control and cost protection

| setting | default | effect |
|---|---|---|
| `ALLOWED_EMAILS` | empty (any verified Google account) | comma-separated sign-in allowlist. **Set this for a demo.** |
| `HARDWARE_EMAILS` | empty (everyone, capped) | who may submit to paid QPUs (IBM, IonQ) or enable autonomous QPU use |
| `LIMIT_<ACTION>` | see below | per-user quota per window. `0` disables the action and a negative value removes the limit |
| `CAP_AUTONOMOUS_JOBS` / `CAP_QPU_JOBS` | 50 / 4 | ceilings on the self-service agent budgets in `/v1/session` |
| `MAX_BODY_BYTES` | 6 MiB | requests with a larger declared `Content-Length` are rejected |

Default quotas, per user:

| action | limit |
|---|---|
| `job` | 120/h |
| `hardware_job` | 4/day |
| `agent_iteration` | 40/day |
| `agent_message` | 60/h |
| `preview` | 30/min |
| `experiment` | 200/day |
| `ingest_token` | 30/day |
| `recording` | 60/day |
| `snapshot` | 20/min |

Exceeding a quota returns HTTP 429 with `Retry-After`. `GET /v1/config` lists the active limits.

Device tokens for the OpenBCI bridge expire after 12 h and only their SHA-256 hash is stored. You
can list them with `GET /v1/eeg/ingest-tokens` and revoke them with `POST /v1/eeg/ingest-tokens/revoke`.
The revoke body is `{"id": "<prefix>"}`, or `{}` to revoke all.

## Operations

- **Logs.** Cloud Logging receives structured JSON (`severity`, `message`, `logger`, `exception`).
  Stack traces stay in the logs and the job document and are never returned by the API.
- **Retries.** A task may arrive more than once. Jobs are claimed transactionally (`queued → running`),
  and a cancellation always wins over a finishing worker. A transient provider-poll error backs off
  and retries, up to 12 consecutive errors, instead of failing a paid hardware job.
- **Timeouts.** The worker request timeout and the task dispatch deadline are both 1800 s. The
  heartbeat marks jobs with no progress for 45 min as failed.
- **Large results.** If a job document would exceed Firestore's 1 MiB limit, the bulky fields
  (`isa_circuit`, `qasm`, `counts`, …) are moved to GCS and replaced with a `<field>_path` pointer.

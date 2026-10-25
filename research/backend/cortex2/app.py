"""cortex² research service (FastAPI). See docs/cortex2-api.md for the contract.

One image, two Cloud Run services (SERVICE_ROLE):
  api      cortex2         public: /v1 API + the built /lab web app (same origin); /internal/* is 404
  worker   cortex2-worker  private: /internal/tasks (Cloud Tasks, OIDC) and /internal/heartbeat (Scheduler)
Locally (SERVICE_ROLE=all, the default) one process does both and runs tasks on threads.
"""
from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import secrets
import sys
import threading
import time
from contextlib import asynccontextmanager
from datetime import timedelta
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel, Field

from . import agent, eeg, inverse as inv, limits, llm, neural as nm, quantum as qm, runner, tasks
from .store import artifacts, now, on_gcp, store, utcnow


# ---------------------------------------------------------------- logging

class JsonFormatter(logging.Formatter):
    """Cloud Logging structured format (severity + message, plus exception text)."""

    def format(self, record):
        entry = {"severity": record.levelname, "message": record.getMessage(), "logger": record.name}
        if record.exc_info:
            entry["exception"] = self.formatException(record.exc_info)
        return json.dumps(entry)


def _configure_logging():
    level = os.environ.get("LOG_LEVEL", "INFO")
    if on_gcp():
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(JsonFormatter())
        logging.basicConfig(level=level, handlers=[handler], force=True)
    else:
        logging.basicConfig(level=level)


_configure_logging()
log = logging.getLogger("cortex2.api")

CLIENT_ID = os.environ.get("GOOGLE_OAUTH_CLIENT_ID", "")
DEV_AUTH = os.environ.get("DEV_AUTH") == "1" and not on_gcp()
ALLOWED_EMAILS = {e.strip().lower() for e in os.environ.get("ALLOWED_EMAILS", "").split(",") if e.strip()}
WEB_DIST = Path(os.environ.get("WEB_DIST", Path(__file__).resolve().parents[3] / "apps" / "web" / "dist"))
VERSION = os.environ.get("CORTEX_VERSION", "dev")
SERVICE_ROLE = os.environ.get("SERVICE_ROLE", "all")            # api | worker | all
MAX_BODY_BYTES = int(os.environ.get("MAX_BODY_BYTES", str(6 * 1024 * 1024)))
# Self-service budget ceilings: users can lower their autonomous budgets, never raise past these.
CAP_AUTONOMOUS_JOBS = int(os.environ.get("CAP_AUTONOMOUS_JOBS", "50"))
CAP_QPU_JOBS = int(os.environ.get("CAP_QPU_JOBS", "4"))
INGEST_MIN_INTERVAL = float(os.environ.get("INGEST_MIN_INTERVAL", "0.8"))   # Firestore: ~1 write/s/doc
INGEST_TOKEN_HOURS = 12

@asynccontextmanager
async def lifespan(_app):
    """Cold starts: import Qiskit *before* serving (a first import racing a request thread can crash
    its native extension), then build the pure-numpy forward-model table in the background."""
    try:
        import qiskit  # noqa: F401
        from qiskit import QuantumCircuit

        QuantumCircuit(1)
    except Exception:
        log.exception("qiskit warm-up failed")

    def warm():
        try:
            nm.forward_table()
        except Exception:
            log.exception("forward-model warm-up failed")
    threading.Thread(target=warm, name="warmup", daemon=True).start()
    yield


app = FastAPI(title="cortex² research service", version=VERSION, lifespan=lifespan)
origins = [o for o in os.environ.get("CORS_ORIGINS", "").split(",") if o and o != "*"]
if origins:
    app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["GET", "POST"],
                       allow_headers=["Authorization", "Content-Type"])
tasks.set_local_handler(runner.handle_task)

CSP = ("default-src 'self'; "
       "script-src 'self' https://accounts.google.com/gsi/client; "
       "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style; "
       "frame-src https://accounts.google.com/gsi/; "
       "img-src 'self' data: blob: https://lh3.googleusercontent.com; font-src 'self' data:; "
       "connect-src 'self' https://accounts.google.com/gsi/ ws://127.0.0.1:8765 ws://localhost:8765; "
       "worker-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")


@app.middleware("http")
async def guard_requests(request: Request, call_next):
    length = request.headers.get("content-length")
    if length and length.isdigit() and int(length) > MAX_BODY_BYTES:
        return JSONResponse({"detail": f"request body over {MAX_BODY_BYTES} bytes"}, status_code=413)
    if request.url.path.startswith("/internal/") and SERVICE_ROLE == "api":
        return JSONResponse({"detail": "not found"}, status_code=404)
    response = await call_next(request)
    h = response.headers
    h.setdefault("X-Content-Type-Options", "nosniff")
    h.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    if on_gcp():
        h.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
    if request.url.path.startswith("/v1"):
        h.setdefault("Cache-Control", "no-store")
    else:
        h.setdefault("Content-Security-Policy", CSP)
        h.setdefault("Cross-Origin-Opener-Policy", "same-origin-allow-popups")   # Google sign-in popup
    return response


@app.exception_handler(limits.RateLimited)
async def rate_limited(_request: Request, exc: limits.RateLimited):
    return JSONResponse({"detail": str(exc)}, status_code=429, headers={"Retry-After": str(exc.retry_after)})


# ---------------------------------------------------------------- auth

_token_cache: dict[str, tuple[float, dict]] = {}


def current_user(authorization: str = Header(default="")) -> dict:
    scheme, _, raw = authorization.partition(" ")
    if scheme.lower() != "bearer" or not raw:
        raise HTTPException(401, "sign in required")
    if DEV_AUTH and raw == "dev":
        return {"uid": "dev", "email": "dev@localhost", "name": "Local developer", "picture": None}
    if not CLIENT_ID:
        raise HTTPException(503, "Google sign-in is not configured: set GOOGLE_OAUTH_CLIENT_ID")
    key = hashlib.sha256(raw.encode()).hexdigest()
    cached = _token_cache.get(key)
    if cached and cached[0] > time.time():
        return cached[1]
    from google.auth.transport.requests import Request as GoogleRequest
    from google.oauth2 import id_token

    try:
        claims = id_token.verify_oauth2_token(raw, GoogleRequest(), CLIENT_ID)
    except Exception as exc:
        raise HTTPException(401, "invalid or expired Google sign-in; sign in again") from exc
    if not claims.get("email_verified"):
        raise HTTPException(403, "Google account email is not verified")
    email = (claims.get("email") or "").lower()
    if ALLOWED_EMAILS and email not in ALLOWED_EMAILS:
        raise HTTPException(403, f"{email} is not on this deployment's allowlist")
    user = {"uid": claims["sub"], "email": email, "name": claims.get("name"), "picture": claims.get("picture")}
    if len(_token_cache) > 2000:
        _token_cache.clear()
    _token_cache[key] = (float(claims["exp"]), user)
    return user


def internal_caller(authorization: str = Header(default="")) -> None:
    """Cloud Tasks / Scheduler OIDC tokens minted for the task service account."""
    if SERVICE_ROLE == "api":
        raise HTTPException(404, "not found")
    if not on_gcp():
        return
    expected = os.environ.get("TASK_SERVICE_ACCOUNT", "")
    audience = os.environ.get("WORKER_URL", "").rstrip("/")
    scheme, _, raw = authorization.partition(" ")
    if scheme.lower() != "bearer" or not expected or not audience:
        raise HTTPException(403, "worker identity not configured")
    from google.auth.transport.requests import Request as GoogleRequest
    from google.oauth2 import id_token

    try:
        claims = id_token.verify_oauth2_token(raw, GoogleRequest(), audience)
    except Exception as exc:
        raise HTTPException(403, "invalid task identity") from exc
    if claims.get("email") != expected or not claims.get("email_verified", True):
        raise HTTPException(403, "unexpected task identity")


def guard(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except KeyError as exc:
        raise HTTPException(404, str(exc).strip("'\"")) from exc
    except PermissionError as exc:
        raise HTTPException(503, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


def public_job(job: dict | None) -> dict | None:
    """Server-internal fields (stack traces) are logged, not returned."""
    if job:
        job.pop("traceback", None)
    return job


# ---------------------------------------------------------------- config / session

@app.get("/v1/config")
def config():
    return {"auth": {"google_client_id": CLIENT_ID, "dev_auth": DEV_AUTH}, "version": VERSION,
            "model": agent.model_name(), "agent_configured": agent.agent_configured(), "model_providers": llm.router().status(),
            "gate_budget": qm.GATE_BUDGET, "offline_target": qm.OFFLINE_TARGET,
            "providers": runner.provider_availability(),
            "param_names": list(nm.PARAM_NAMES), "param_levels": nm.LEVELS.tolist(),
            "feature_names": list(nm.FEATURE_NAMES), "approximations": list(inv.APPROXIMATIONS),
            "limits": {a: {"window_seconds": limits.limit_for(a).window, "max": limits.limit_for(a).maximum}
                       for a in limits.DEFAULTS}}


@app.get("/health")
def healthz():
    return {"ok": True, "version": VERSION}


@app.get("/v1/me")
def me(user=Depends(current_user)):
    return {**user, "hardware_allowed": limits.hardware_allowed(user.get("email"))}


@app.get("/v1/session")
def get_session(user=Depends(current_user)):
    return agent.session(user["uid"])


@app.post("/v1/session")
def post_session(body: dict, user=Depends(current_user)):
    clean = dict(body)
    if "max_autonomous_jobs" in clean:
        clean["max_autonomous_jobs"] = min(int(clean["max_autonomous_jobs"]), CAP_AUTONOMOUS_JOBS)
    if "qpu_jobs_budget" in clean:
        clean["qpu_jobs_budget"] = min(int(clean["qpu_jobs_budget"]), CAP_QPU_JOBS)
    if clean.get("allow_autonomous_qpu") and not limits.hardware_allowed(user.get("email")):
        raise HTTPException(403, "this account may not use physical QPUs (HARDWARE_EMAILS)")
    return agent.update_session(user["uid"], clean)


# ---------------------------------------------------------------- datasets / experiments

@app.get("/v1/datasets")
def datasets(user=Depends(current_user)):
    ds = [{k: d[k] for k in ("id", "label", "kind", "fs", "channels", "seizures", "citation", "license", "source")}
          | {"segments": {k: v for k, v in d["segments"].items()}} for d in eeg.datasets()]
    return {"datasets": ds, "synthetic_presets": runner.SYNTHETIC_PRESETS}


class ExperimentRequest(BaseModel):
    source: str = Field(default="synthetic", max_length=20)
    truth_bitstring: str | None = Field(default=None, pattern="^[01]{8}$")
    random_seed: int | None = Field(default=None, ge=0, le=2**31)
    dataset_id: str | None = Field(default=None, max_length=80)
    channel: str | None = Field(default=None, max_length=40)
    segment: str | None = Field(default=None, max_length=40)
    recording_id: str | None = Field(default=None, max_length=64)
    title: str | None = Field(default=None, max_length=160)
    start: float | None = Field(default=None, ge=0, le=1e6)
    end: float | None = Field(default=None, ge=0, le=1e6)


@app.post("/v1/experiments")
def new_experiment(req: ExperimentRequest, user=Depends(current_user)):
    limits.consume(user["uid"], "experiment")
    return {"experiment": guard(runner.create_experiment, user["uid"], req.model_dump(exclude_none=True))}


@app.get("/v1/experiments")
def list_experiments(user=Depends(current_user)):
    rows = store().query("experiments", user["uid"], limit=60)
    for r in rows:
        r.pop("observed_trace", None)
    return {"experiments": rows}


@app.get("/v1/experiments/{exp_id}")
def get_experiment(exp_id: str, user=Depends(current_user)):
    exp = guard(runner.owned, "experiments", exp_id, user["uid"])
    target = runner.target_of(exp)
    return {"experiment": exp, "landscape": inv.landscape(target),
            "jobs": [public_job(j) for j in store().query("jobs", user["uid"], experiment_id=exp_id, limit=100)],
            "revisions": store().query("revisions", user["uid"], experiment_id=exp_id, limit=100)}


@app.get("/v1/experiments/{exp_id}/export")
def export_experiment(exp_id: str, user=Depends(current_user)):
    data = get_experiment(exp_id, user)
    data["reproducibility"] = {"code_version": VERSION, "model": data["experiment"].get("model_version"),
                               "observation_seed": inv.OBSERVATION_SEED, "offline_target": qm.OFFLINE_TARGET,
                               "exported_at": now(), "note": "rerun any job by POSTing its provider/approximation/baseline/spec/qasm"}
    safe_id = "".join(c for c in exp_id if c.isalnum())[:40]
    return JSONResponse(data, headers={"Content-Disposition": f'attachment; filename="cortex2-{safe_id}.json"'})


class JobRequest(BaseModel):
    provider: str = Field(max_length=40)
    approximation: str = Field(default="trust_region", max_length=40)
    baseline: str | None = Field(default=None, pattern="^[01]{8}$")
    trust_weight: float = Field(default=0.15, ge=0, le=5)
    spec: dict | None = None
    qasm: str | None = Field(default=None, max_length=qm.MAX_QASM_CHARS)
    shots: int = Field(default=qm.DEFAULT_SHOTS, ge=64, le=8192)
    validation_budget: int = Field(default=inv.DEFAULT_VALIDATION_BUDGET, ge=1, le=64)
    title: str | None = Field(default=None, max_length=160)


def check_spec(spec: dict | None) -> None:
    if spec is not None and len(json.dumps(spec)) > 8000:
        raise HTTPException(400, "spec too large")


@app.post("/v1/experiments/{exp_id}/jobs")
def new_job(exp_id: str, req: JobRequest, user=Depends(current_user)):
    check_spec(req.spec)
    guard(runner.owned, "experiments", exp_id, user["uid"])
    if req.provider in runner.HARDWARE_PROVIDERS:
        if not limits.hardware_allowed(user.get("email")):
            raise HTTPException(403, "this account may not use physical QPUs (HARDWARE_EMAILS)")
        limits.consume(user["uid"], "hardware_job")
    limits.consume(user["uid"], "job")
    return {"job": public_job(guard(runner.create_job, user["uid"], exp_id, req.model_dump(exclude_none=True)))}


class PreviewRequest(JobRequest):
    experiment_id: str = Field(max_length=64)
    provider: str = Field(default="aer_ideal", max_length=40)


@app.post("/v1/circuits/preview")
def circuit_preview(req: PreviewRequest, user=Depends(current_user)):
    check_spec(req.spec)
    exp = guard(runner.owned, "experiments", req.experiment_id, user["uid"])
    limits.consume(user["uid"], "preview")
    return guard(runner.preview, exp, req.model_dump(exclude_none=True))


@app.get("/v1/jobs")
def list_jobs(experiment_id: str | None = None, user=Depends(current_user)):
    eq = {"experiment_id": experiment_id} if experiment_id else {}
    return {"jobs": [public_job(j) for j in store().query("jobs", user["uid"], limit=100, **eq)]}


@app.get("/v1/jobs/{job_id}")
def get_job(job_id: str, user=Depends(current_user)):
    return {"job": public_job(guard(runner.owned, "jobs", job_id, user["uid"]))}


@app.post("/v1/jobs/{job_id}/cancel")
def cancel(job_id: str, user=Depends(current_user)):
    return {"job": public_job(guard(runner.cancel_job, user["uid"], job_id))}


@app.get("/v1/eeg/spectrogram")
def eeg_spectrogram(dataset_id: str | None = None, recording_id: str | None = None, start: float | None = None,
                    end: float | None = None, channels: str | None = None, user=Depends(current_user)):
    """Per-channel spectrogram grid (PNG) — the same image the agent looks at during EEG triage."""
    from . import render

    src = guard(eeg.load_source, user["uid"], dataset_id=dataset_id, recording_id=recording_id, start=start, end=end)
    picks = [c for c in (channels or "").split(",") if c]
    png = render.spectrogram_grid(src, picks or None)
    return Response(png, media_type="image/png", headers={"Cache-Control": "private, max-age=300"})


class TriageRequest(BaseModel):
    dataset_id: str | None = Field(default=None, max_length=80)
    recording_id: str | None = Field(default=None, max_length=64)
    start: float | None = None
    end: float | None = None
    instruction: str | None = Field(default=None, max_length=2000)


@app.post("/v1/eeg/triage")
def eeg_triage(body: TriageRequest, user=Depends(current_user)):
    """Gemini looks at every channel's spectrogram, picks channels/windows and splinters them into quantum searches."""
    if not (body.dataset_id or body.recording_id):
        raise HTTPException(400, "give dataset_id or recording_id")
    if not agent.agent_configured():
        raise HTTPException(503, "no model provider configured")
    src = f"dataset_id={body.dataset_id}" if body.dataset_id else f"recording_id={body.recording_id}"
    window = f" window {body.start}–{body.end} s" if body.start is not None and body.end is not None else ""
    text = (f"EEG triage on {src}{window}: render the per-channel spectrograms, look at them, pick the 2–4 most informative "
            "channels/windows, create one inverse experiment per pick, dispatch quantum searches on each, then compare the "
            "hypothesis sets across channels. " + (body.instruction or ""))
    item = runner.feed(user["uid"], "user", text)
    job = agent.schedule_operator(user["uid"], text, None, created_by="user")
    return {"item": item, "job": job}


@app.get("/v1/hypotheses/{bitstring}/trace")
def hypothesis_trace(bitstring: str, seconds: float = 2.0, user=Depends(current_user)):
    if len(bitstring) != nm.N_BITS or set(bitstring) - {"0", "1"}:
        raise HTTPException(400, "bitstring must be 8 binary digits")
    seconds = float(min(max(seconds, 0.25), 8.0))
    x = inv.simulated_trace(bitstring, seconds)
    k = nm.grid_index(nm.bitstring_to_bits(bitstring))
    step = max(1, len(x) // 1000)
    return {"fs": nm.SIM_FS / step, "samples": [round(float(v), 4) for v in x[::step]],
            "parameters": nm.describe_params(nm.forward_table().params[k]),
            "features": nm.forward_table().features[k].tolist(),
            "bands": nm.band_powers(nm.forward_table().traces[:, k], nm.SIM_FS)}


# ---------------------------------------------------------------- agent

class Instruction(BaseModel):
    instruction: str | None = Field(default=None, max_length=4000)


@app.post("/v1/experiments/{exp_id}/agent/iterate")
def iterate(exp_id: str, body: Instruction, user=Depends(current_user)):
    guard(runner.owned, "experiments", exp_id, user["uid"])
    if not agent.agent_configured():
        raise HTTPException(503, "no model provider configured: set GEMINI_API_KEY or AGENT_PROVIDERS")
    limits.consume(user["uid"], "agent_iteration")
    job = guard(agent.start_iteration, user["uid"], exp_id, body.instruction)
    runner.feed(user["uid"], "user", body.instruction or "Run one design iteration.", exp_id, job["id"])
    return {"job": job}


@app.get("/v1/experiments/{exp_id}/revisions")
def revisions(exp_id: str, user=Depends(current_user)):
    guard(runner.owned, "experiments", exp_id, user["uid"])
    return {"revisions": store().query("revisions", user["uid"], experiment_id=exp_id, limit=100)}


class Message(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    experiment_id: str | None = Field(default=None, max_length=64)


@app.post("/v1/agent/messages")
def message(body: Message, user=Depends(current_user)):
    if body.experiment_id:
        guard(runner.owned, "experiments", body.experiment_id, user["uid"])
    if not agent.agent_configured():
        raise HTTPException(503, "no model provider configured: set GEMINI_API_KEY or AGENT_PROVIDERS")
    limits.consume(user["uid"], "agent_message")
    item = runner.feed(user["uid"], "user", body.text, body.experiment_id)
    job = agent.schedule_operator(user["uid"], body.text, body.experiment_id, created_by="user")
    return {"item": item, "job": job}


@app.get("/v1/feed")
def get_feed(experiment_id: str | None = None, user=Depends(current_user)):
    eq = {"experiment_id": experiment_id} if experiment_id else {}
    return {"items": store().query("feed", user["uid"], order="time", limit=120, **eq)}


# ---------------------------------------------------------------- artifacts

@app.get("/v1/artifacts/{path:path}")
def artifact(path: str, user=Depends(current_user)):
    if not path.startswith(user["uid"] + "/") or not artifacts().safe(path) or not path.endswith(".png"):
        raise HTTPException(404, "not found")
    data = artifacts().get(path)
    if data is None:
        raise HTTPException(404, "not found")
    return Response(data, media_type="image/png", headers={"Cache-Control": "private, max-age=3600"})


class Snapshot(BaseModel):
    png: str = Field(max_length=4_000_000)


@app.post("/v1/experiments/{exp_id}/snapshot")
def snapshot(exp_id: str, body: Snapshot, user=Depends(current_user)):
    guard(runner.owned, "experiments", exp_id, user["uid"])
    limits.consume(user["uid"], "snapshot")
    raw = body.png.split(",", 1)[-1]
    try:
        data = base64.b64decode(raw, validate=True)
    except ValueError as exc:
        raise HTTPException(400, "png must be base64") from exc
    if not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise HTTPException(400, "not a png")
    artifacts().put(f"{user['uid']}/{exp_id}/snapshot.png", data)
    return {"ok": True}


# ---------------------------------------------------------------- EEG

def _token_hash(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def device_owner(authorization: str) -> str:
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise HTTPException(401, "missing device token")
    doc = store().get("ingest_tokens", _token_hash(token.strip()))
    if not doc or doc.get("revoked"):
        raise HTTPException(403, "device token invalid or revoked")
    if doc["expires_at"] < now():
        raise HTTPException(403, "device token expired; create a new one in the lab")
    return doc["owner"]


@app.post("/v1/eeg/ingest-token")
def ingest_token(user=Depends(current_user)):
    limits.consume(user["uid"], "ingest_token")
    raw = secrets.token_urlsafe(32)
    expires = utcnow() + timedelta(hours=INGEST_TOKEN_HOURS)
    # Only the SHA-256 of the token is stored; `expire_at` (timestamp) drives a Firestore TTL policy.
    store().create("ingest_tokens", {"owner": user["uid"], "created_at": now(), "expires_at": expires.isoformat(),
                                     "expire_at": expires + timedelta(days=1), "revoked": False},
                   doc_id=_token_hash(raw))
    return {"token": raw, "expires_in_seconds": INGEST_TOKEN_HOURS * 3600}


@app.get("/v1/eeg/ingest-tokens")
def list_ingest_tokens(user=Depends(current_user)):
    rows = store().query("ingest_tokens", user["uid"], limit=100)
    return {"tokens": [{"id": r["id"][:12], "created_at": r.get("created_at"), "expires_at": r.get("expires_at"),
                        "active": not r.get("revoked") and r.get("expires_at", "") > now()} for r in rows]}


class Revoke(BaseModel):
    id: str | None = Field(default=None, min_length=6, max_length=64, description="token id prefix; omit to revoke all")


@app.post("/v1/eeg/ingest-tokens/revoke")
def revoke_ingest_tokens(body: Revoke, user=Depends(current_user)):
    n = 0
    for r in store().query("ingest_tokens", user["uid"], limit=500):
        if (body.id is None or r["id"].startswith(body.id)) and not r.get("revoked"):
            store().update("ingest_tokens", r["id"], {"revoked": True, "revoked_at": now()})
            n += 1
    return {"revoked": n}


class Frame(BaseModel):
    board: str = Field(default="openbci", max_length=40)
    fs: float = Field(gt=0, le=20000)
    channel_names: list[str] = Field(max_length=32)
    samples: list[list[float]] = Field(max_length=32)
    bands: dict[str, float] = Field(default_factory=dict, max_length=16)
    per_channel_bands: list[dict] = Field(default_factory=list, max_length=32)
    blink: bool = False
    quality: str = Field(default="unverified", max_length=200)


_last_ingest: dict[str, float] = {}


@app.post("/v1/eeg/ingest")
def ingest(frame: Frame, authorization: str = Header(default="")):
    owner = device_owner(authorization)
    if any(len(ch) > 512 for ch in frame.samples) or any(len(n) > 40 for n in frame.channel_names):
        raise HTTPException(413, "at most 512 samples per channel per frame")
    t = time.monotonic()
    if t - _last_ingest.get(owner, 0.0) < INGEST_MIN_INTERVAL and not frame.blink:
        return {"ok": True, "throttled": True}      # one live doc per user: stay under Firestore's ~1 write/s/doc
    _last_ingest[owner] = t
    store().set("eeg_streams", owner, {"owner": owner, **frame.model_dump(), "updated_at": now(),
                                       "expire_at": utcnow() + timedelta(days=1)})
    return {"ok": True}


@app.get("/v1/eeg/latest")
def eeg_latest(user=Depends(current_user)):
    doc = store().get("eeg_streams", user["uid"])
    if not doc:
        return {"live": False, "frame": None}
    fresh = str(doc.get("updated_at", "")) > (utcnow() - timedelta(seconds=10)).isoformat()
    doc.pop("expire_at", None)
    return {"live": fresh, "frame": doc if fresh else None}


class Recording(BaseModel):
    label: str = Field(max_length=120)
    fs: float = Field(gt=0, le=2000)
    channel_names: list[str] = Field(min_length=1, max_length=16)
    data: list[list[float]] = Field(min_length=1, max_length=16)


@app.post("/v1/eeg/recordings")
def upload_recording(rec: Recording, authorization: str = Header(default="")):
    owner = device_owner(authorization)
    limits.consume(owner, "recording")
    n = len(rec.data[0])
    if len(rec.data) != len(rec.channel_names) or any(len(ch) != n for ch in rec.data):
        raise HTTPException(400, "data must be one equal-length list per channel")
    if n / rec.fs > 60.5 or n * len(rec.data) > 120_000:
        raise HTTPException(413, "at most 60 s and 120k samples per recording")
    if n < 4 * rec.fs:
        raise HTTPException(400, "record at least 4 s")
    rid = secrets.token_hex(10)
    # Samples go to GCS (a 120k-sample recording would exceed Firestore's 1 MiB document limit).
    path = artifacts().put_json(f"{owner}/recordings/{rid}.json.gz", [[round(v, 3) for v in ch] for ch in rec.data])
    store().create("eeg_recordings", {"owner": owner, "label": rec.label, "fs": rec.fs, "channel_names": rec.channel_names,
                                      "data_path": path, "seconds": n / rec.fs, "created_at": now()}, doc_id=rid)
    runner.feed(owner, "system", f"OpenBCI recording '{rec.label}' uploaded ({n / rec.fs:.1f} s, {len(rec.data)} channels).")
    return {"recording_id": rid}


@app.get("/v1/eeg/recordings")
def list_recordings(user=Depends(current_user)):
    rows = store().query("eeg_recordings", user["uid"], limit=50)
    return {"recordings": [{k: r.get(k) for k in ("id", "label", "fs", "channel_names", "seconds", "created_at")} for r in rows]}


# ---------------------------------------------------------------- worker

@app.post("/internal/tasks", dependencies=[Depends(internal_caller)])
def internal_task(payload: dict):
    try:
        payload = tasks.valid_payload(payload)
    except ValueError as exc:
        # 200 so Cloud Tasks does not retry a malformed task forever
        log.error("rejected task payload: %s", exc)
        return {"rejected": str(exc)}
    return runner.handle_task(payload)


@app.post("/internal/heartbeat", dependencies=[Depends(internal_caller)])
def internal_heartbeat():
    return agent.heartbeat()


# ---------------------------------------------------------------- web app (same origin)

@app.get("/{path:path}", include_in_schema=False)
def web(path: str):
    if path.startswith(("v1/", "internal/")):
        raise HTTPException(404, "not found")
    if not WEB_DIST.exists():
        return JSONResponse({"service": "cortex2", "web": "not bundled; run the Vite dev server"}, status_code=404)
    root = WEB_DIST.resolve()
    candidate = (WEB_DIST / path).resolve()
    if path and candidate.is_file() and root in candidate.parents:
        cache = "public, max-age=31536000, immutable" if "/assets/" in f"/{path}" else "public, max-age=300"
        return FileResponse(candidate, headers={"Cache-Control": cache})
    return FileResponse(WEB_DIST / "index.html", headers={"Cache-Control": "no-cache"})

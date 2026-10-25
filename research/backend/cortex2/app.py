"""cortex² research service (FastAPI). See docs/cortex2-api.md for the contract.

One image, two Cloud Run services:
  cortex2         public: /v1 API + the built /lab web app (same origin)
  cortex2-worker  private: /internal/tasks (Cloud Tasks, OIDC) and /internal/heartbeat (Cloud Scheduler)
Locally the same process does both and runs tasks on threads.
"""
from __future__ import annotations

import base64
import hashlib
import logging
import os
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel, Field

from . import agent, eeg, inverse as inv, llm, neural as nm, quantum as qm, runner, tasks
from .store import artifacts, now, on_gcp, store

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger("cortex2.api")

CLIENT_ID = os.environ.get("GOOGLE_OAUTH_CLIENT_ID", "")
DEV_AUTH = os.environ.get("DEV_AUTH") == "1" and not on_gcp()
ALLOWED_EMAILS = {e.strip().lower() for e in os.environ.get("ALLOWED_EMAILS", "").split(",") if e.strip()}
WEB_DIST = Path(os.environ.get("WEB_DIST", Path(__file__).resolve().parents[3] / "apps" / "web" / "dist"))
VERSION = os.environ.get("CORTEX_VERSION", "dev")

app = FastAPI(title="cortex² research service", version=VERSION)
origins = [o for o in os.environ.get("CORS_ORIGINS", "").split(",") if o]
if origins:
    app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["GET", "POST"],
                       allow_headers=["Authorization", "Content-Type"])
tasks.set_local_handler(runner.handle_task)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    if request.url.path.startswith("/v1"):
        response.headers.setdefault("Cache-Control", "no-store")
    else:
        response.headers.setdefault("Content-Security-Policy",
            "default-src 'self'; script-src 'self' https://accounts.google.com/gsi/client; "
            "frame-src https://accounts.google.com; style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style; "
            "img-src 'self' data: blob: https://lh3.googleusercontent.com; font-src 'self' data:; "
            "connect-src 'self' https://accounts.google.com ws://127.0.0.1:8765 ws://localhost:8765; "
            "worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'")
    return response


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
    cached = _token_cache.get(raw)
    if cached and cached[0] > datetime.now(timezone.utc).timestamp():
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
    _token_cache[raw] = (float(claims["exp"]), user)
    return user


def internal_caller(authorization: str = Header(default="")) -> None:
    """Cloud Tasks / Scheduler OIDC tokens minted for the task service account."""
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
    if claims.get("email") != expected:
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


# ---------------------------------------------------------------- config / session

@app.get("/v1/config")
def config():
    return {"auth": {"google_client_id": CLIENT_ID, "dev_auth": DEV_AUTH}, "version": VERSION,
            "model": agent.model_name(), "agent_configured": agent.agent_configured(), "model_providers": llm.router().status(),
            "gate_budget": qm.GATE_BUDGET, "offline_target": qm.OFFLINE_TARGET,
            "providers": runner.provider_availability(),
            "param_names": list(nm.PARAM_NAMES), "param_levels": nm.LEVELS.tolist(),
            "feature_names": list(nm.FEATURE_NAMES), "approximations": list(inv.APPROXIMATIONS)}


@app.get("/health")
def healthz():
    return {"ok": True, "version": VERSION}


@app.get("/v1/me")
def me(user=Depends(current_user)):
    return user


@app.get("/v1/session")
def get_session(user=Depends(current_user)):
    return agent.session(user["uid"])


@app.post("/v1/session")
def post_session(body: dict, user=Depends(current_user)):
    return agent.update_session(user["uid"], body)


# ---------------------------------------------------------------- datasets / experiments

@app.get("/v1/datasets")
def datasets(user=Depends(current_user)):
    ds = [{k: d[k] for k in ("id", "label", "kind", "fs", "channels", "seizures", "citation", "license", "source")}
          | {"segments": {k: v for k, v in d["segments"].items()}} for d in eeg.datasets()]
    return {"datasets": ds, "synthetic_presets": runner.SYNTHETIC_PRESETS}


class ExperimentRequest(BaseModel):
    source: str = "synthetic"
    truth_bitstring: str | None = Field(default=None, pattern="^[01]{8}$")
    random_seed: int | None = None
    dataset_id: str | None = None
    channel: str | None = None
    segment: str | None = None
    recording_id: str | None = None
    title: str | None = Field(default=None, max_length=160)


@app.post("/v1/experiments")
def new_experiment(req: ExperimentRequest, user=Depends(current_user)):
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
            "jobs": store().query("jobs", user["uid"], experiment_id=exp_id, limit=100),
            "revisions": store().query("revisions", user["uid"], experiment_id=exp_id, limit=100)}


@app.get("/v1/experiments/{exp_id}/export")
def export_experiment(exp_id: str, user=Depends(current_user)):
    data = get_experiment(exp_id, user)
    data["reproducibility"] = {"code_version": VERSION, "model": data["experiment"].get("model_version"),
                               "observation_seed": inv.OBSERVATION_SEED, "offline_target": qm.OFFLINE_TARGET,
                               "exported_at": now(), "note": "rerun any job by POSTing its provider/approximation/baseline/spec/qasm"}
    return JSONResponse(data, headers={"Content-Disposition": f'attachment; filename="cortex2-{exp_id}.json"'})


class JobRequest(BaseModel):
    provider: str
    approximation: str = "trust_region"
    baseline: str | None = Field(default=None, pattern="^[01]{8}$")
    trust_weight: float = Field(default=0.15, ge=0, le=5)
    spec: dict | None = None
    qasm: str | None = Field(default=None, max_length=qm.MAX_QASM_CHARS)
    shots: int = Field(default=qm.DEFAULT_SHOTS, ge=64, le=8192)
    validation_budget: int = Field(default=inv.DEFAULT_VALIDATION_BUDGET, ge=1, le=64)
    title: str | None = Field(default=None, max_length=160)


@app.post("/v1/experiments/{exp_id}/jobs")
def new_job(exp_id: str, req: JobRequest, user=Depends(current_user)):
    return {"job": guard(runner.create_job, user["uid"], exp_id, req.model_dump(exclude_none=True))}


class PreviewRequest(JobRequest):
    experiment_id: str
    provider: str = "aer_ideal"


@app.post("/v1/circuits/preview")
def circuit_preview(req: PreviewRequest, user=Depends(current_user)):
    exp = guard(runner.owned, "experiments", req.experiment_id, user["uid"])
    return guard(runner.preview, exp, req.model_dump(exclude_none=True))


@app.get("/v1/jobs")
def list_jobs(experiment_id: str | None = None, user=Depends(current_user)):
    eq = {"experiment_id": experiment_id} if experiment_id else {}
    return {"jobs": store().query("jobs", user["uid"], limit=100, **eq)}


@app.get("/v1/jobs/{job_id}")
def get_job(job_id: str, user=Depends(current_user)):
    return {"job": guard(runner.owned, "jobs", job_id, user["uid"])}


@app.post("/v1/jobs/{job_id}/cancel")
def cancel(job_id: str, user=Depends(current_user)):
    return {"job": guard(runner.cancel_job, user["uid"], job_id)}


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
    job = guard(agent.start_iteration, user["uid"], exp_id, body.instruction)
    runner.feed(user["uid"], "user", body.instruction or "Run one design iteration.", exp_id, job["id"])
    return {"job": job}


@app.get("/v1/experiments/{exp_id}/revisions")
def revisions(exp_id: str, user=Depends(current_user)):
    guard(runner.owned, "experiments", exp_id, user["uid"])
    return {"revisions": store().query("revisions", user["uid"], experiment_id=exp_id, limit=100)}


class Message(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    experiment_id: str | None = None


@app.post("/v1/agent/messages")
def message(body: Message, user=Depends(current_user)):
    if body.experiment_id:
        guard(runner.owned, "experiments", body.experiment_id, user["uid"])
    item = runner.feed(user["uid"], "user", body.text, body.experiment_id)
    if not agent.agent_configured():
        raise HTTPException(503, "no model provider configured: set GEMINI_API_KEY or AGENT_PROVIDERS")
    job = agent.schedule_operator(user["uid"], body.text, body.experiment_id, created_by="user")
    return {"item": item, "job": job}


@app.get("/v1/feed")
def get_feed(experiment_id: str | None = None, user=Depends(current_user)):
    eq = {"experiment_id": experiment_id} if experiment_id else {}
    return {"items": store().query("feed", user["uid"], order="time", limit=120, **eq)}


# ---------------------------------------------------------------- artifacts

@app.get("/v1/artifacts/{path:path}")
def artifact(path: str, user=Depends(current_user)):
    if not path.startswith(user["uid"] + "/"):
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
    raw = body.png.split(",", 1)[-1]
    try:
        data = base64.b64decode(raw, validate=True)
    except ValueError as exc:
        raise HTTPException(400, "png must be base64") from exc
    if not data.startswith(b"\x89PNG"):
        raise HTTPException(400, "not a png")
    artifacts().put(f"{user['uid']}/{exp_id}/snapshot.png", data)
    return {"ok": True}


# ---------------------------------------------------------------- EEG

def device_owner(authorization: str) -> str:
    token = authorization.removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(401, "missing device token")
    doc = store().get("ingest_tokens", hashlib.sha256(token.encode()).hexdigest())
    if not doc:
        raise HTTPException(403, "device token invalid")
    if doc["expires_at"] < now():
        raise HTTPException(403, "device token expired; create a new one in the lab")
    return doc["owner"]


@app.post("/v1/eeg/ingest-token")
def ingest_token(user=Depends(current_user)):
    raw = secrets.token_urlsafe(32)
    expires = datetime.now(timezone.utc) + timedelta(hours=12)
    store().create("ingest_tokens", {"owner": user["uid"], "created_at": now(), "expires_at": expires.isoformat()},
                   doc_id=hashlib.sha256(raw.encode()).hexdigest())
    return {"token": raw, "expires_in_seconds": 12 * 3600}


class Frame(BaseModel):
    board: str = Field(default="openbci", max_length=40)
    fs: float = Field(gt=0, le=20000)
    channel_names: list[str] = Field(max_length=32)
    samples: list[list[float]] = Field(max_length=32)
    bands: dict[str, float] = {}
    per_channel_bands: list[dict] = []
    blink: bool = False
    quality: str = Field(default="unverified", max_length=60)


@app.post("/v1/eeg/ingest")
def ingest(frame: Frame, authorization: str = Header(default="")):
    owner = device_owner(authorization)
    if any(len(ch) > 512 for ch in frame.samples):
        raise HTTPException(413, "at most 512 samples per channel per frame")
    store().set("eeg_streams", owner, {"owner": owner, **frame.model_dump(), "updated_at": now()})
    return {"ok": True}


@app.get("/v1/eeg/latest")
def eeg_latest(user=Depends(current_user)):
    doc = store().get("eeg_streams", user["uid"])
    if not doc:
        return {"live": False, "frame": None}
    fresh = doc["updated_at"] > (datetime.now(timezone.utc) - timedelta(seconds=10)).isoformat()
    return {"live": fresh, "frame": doc if fresh else None}


class Recording(BaseModel):
    label: str = Field(max_length=120)
    fs: float = Field(gt=0, le=2000)
    channel_names: list[str] = Field(min_length=1, max_length=16)
    data: list[list[float]] = Field(min_length=1, max_length=16)


@app.post("/v1/eeg/recordings")
def upload_recording(rec: Recording, authorization: str = Header(default="")):
    owner = device_owner(authorization)
    n = len(rec.data[0])
    if len(rec.data) != len(rec.channel_names) or any(len(ch) != n for ch in rec.data):
        raise HTTPException(400, "data must be one equal-length list per channel")
    if n / rec.fs > 60.5 or n * len(rec.data) > 120_000:
        raise HTTPException(413, "at most 60 s and 120k samples per recording")
    if n < 4 * rec.fs:
        raise HTTPException(400, "record at least 4 s")
    doc = store().create("eeg_recordings", {"owner": owner, "label": rec.label, "fs": rec.fs, "channel_names": rec.channel_names,
                                            "data": [[round(v, 3) for v in ch] for ch in rec.data], "seconds": n / rec.fs,
                                            "created_at": now()})
    runner.feed(owner, "system", f"OpenBCI recording '{rec.label}' uploaded ({n / rec.fs:.1f} s, {len(rec.data)} channels).")
    return {"recording_id": doc["id"]}


@app.get("/v1/eeg/recordings")
def list_recordings(user=Depends(current_user)):
    rows = store().query("eeg_recordings", user["uid"], limit=50)
    return {"recordings": [{k: r.get(k) for k in ("id", "label", "fs", "channel_names", "seconds", "created_at")} for r in rows]}


# ---------------------------------------------------------------- worker

@app.post("/internal/tasks", dependencies=[Depends(internal_caller)])
def internal_task(payload: dict):
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
    candidate = (WEB_DIST / path).resolve()
    if path and candidate.is_file() and WEB_DIST.resolve() in candidate.parents:
        cache = "public, max-age=31536000, immutable" if "/assets/" in f"/{path}" else "public, max-age=300"
        return FileResponse(candidate, headers={"Cache-Control": cache})
    return FileResponse(WEB_DIST / "index.html", headers={"Cache-Control": "no-cache"})

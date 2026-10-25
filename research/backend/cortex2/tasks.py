"""Durable background work: Cloud Tasks → OIDC-authenticated worker in production, threads locally.

A task is just `{"job_id", "step"}`; all state lives in the store, so a task can be retried
or duplicated safely (handlers claim jobs transactionally before acting).
"""
from __future__ import annotations

import json
import logging
import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

from .store import on_gcp

log = logging.getLogger("cortex2.tasks")

PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT", "")
REGION = os.environ.get("REGION", os.environ.get("TASK_REGION", "us-central1"))
QUEUE = os.environ.get("TASK_QUEUE", "cortex2-work")
WORKER_URL = os.environ.get("WORKER_URL", "").rstrip("/")
TASK_SA = os.environ.get("TASK_SERVICE_ACCOUNT", "")

# Aer and JAX recurse deeply; macOS gives secondary threads only 512 KB of stack (Linux: 8 MB).
if sys.platform == "darwin":
    threading.stack_size(64 * 1024 * 1024)
_pool = ThreadPoolExecutor(max_workers=int(os.environ.get("LOCAL_WORKERS", "4")), thread_name_prefix="cortex2")
_handler = None
_client = None
STEPS = {"execute", "poll"}


def set_local_handler(fn) -> None:
    """Local mode: the API registers the same function the worker route calls."""
    global _handler
    _handler = fn


def cloud_mode() -> bool:
    return on_gcp() or os.environ.get("CORTEX_TASKS") == "cloud"


def _tasks_client():
    global _client
    if _client is None:                    # one gRPC channel per process, not per enqueue
        from google.cloud import tasks_v2

        _client = tasks_v2.CloudTasksClient()
    return _client


def valid_payload(payload: object) -> dict:
    """Validate a task body (it arrives over HTTP on the worker)."""
    if not isinstance(payload, dict):
        raise ValueError("task payload must be an object")
    job_id, step = payload.get("job_id"), payload.get("step", "execute")
    if not isinstance(job_id, str) or not (1 <= len(job_id) <= 64) or not job_id.replace("-", "").replace("_", "").isalnum():
        raise ValueError("invalid job_id")
    if step not in STEPS:
        raise ValueError(f"invalid step {step!r}")
    try:
        attempt = int(payload.get("attempt", 0))
    except (TypeError, ValueError) as exc:
        raise ValueError("invalid attempt") from exc
    return {"job_id": job_id, "step": step, "attempt": max(0, attempt)}


def enqueue(job_id: str, step: str = "execute", delay: float = 0, attempt: int = 0) -> None:
    payload = valid_payload({"job_id": job_id, "step": step, "attempt": attempt})
    if not cloud_mode():
        if _handler is None:
            raise RuntimeError("no local task handler registered")

        def run():
            try:
                _handler(payload)
            except Exception:
                log.exception("local task failed: %s", payload)

        if delay:
            threading.Timer(delay, lambda: _pool.submit(run)).start()
        else:
            _pool.submit(run)
        return
    if not (PROJECT and WORKER_URL and TASK_SA):
        raise RuntimeError("Cloud Tasks not configured: set GOOGLE_CLOUD_PROJECT, WORKER_URL, TASK_SERVICE_ACCOUNT")
    from google.api_core.exceptions import AlreadyExists
    from google.cloud import tasks_v2
    from google.protobuf import duration_pb2, timestamp_pb2

    client = _tasks_client()
    parent = client.queue_path(PROJECT, REGION, QUEUE)
    url = f"{WORKER_URL}/internal/tasks"
    task = {
        "name": client.task_path(PROJECT, REGION, QUEUE, f"{job_id}-{step}-{attempt}"),
        "http_request": {
            "http_method": tasks_v2.HttpMethod.POST, "url": url,
            "headers": {"Content-Type": "application/json"},
            "oidc_token": {"service_account_email": TASK_SA, "audience": WORKER_URL},
            "body": json.dumps(payload).encode(),
        },
        # equal to the worker's Cloud Run request timeout; longer work must checkpoint
        "dispatch_deadline": duration_pb2.Duration(seconds=1800),
    }
    if delay:
        ts = timestamp_pb2.Timestamp()
        ts.FromDatetime(datetime.now(timezone.utc) + timedelta(seconds=delay))
        task["schedule_time"] = ts
    try:
        client.create_task(request={"parent": parent, "task": task})
    except AlreadyExists:
        pass

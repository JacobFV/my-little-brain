"""Authorization, abuse limits and robustness of the service (local store in strict Firestore mode)."""
import hashlib
import time
from datetime import datetime, timezone

import numpy as np
import pytest
from fastapi.testclient import TestClient

from cortex2 import app as appmod, limits, runner, store as st, tasks
from cortex2.app import app, current_user
from cortex2.store import store

DEV = {"Authorization": "Bearer dev"}
c = TestClient(app)


def as_user(uid, email=None):
    app.dependency_overrides[current_user] = lambda: {"uid": uid, "email": email or f"{uid}@example.com", "name": uid}


@pytest.fixture(autouse=True)
def reset_overrides():
    yield
    app.dependency_overrides.clear()


def wait(job_id, timeout=120):
    end = time.time() + timeout
    while time.time() < end:
        j = c.get(f"/v1/jobs/{job_id}", headers=DEV).json()["job"]
        if j["status"] in ("completed", "failed", "cancelled"):
            return j
        time.sleep(0.2)
    raise AssertionError("job did not finish")


# ---------------------------------------------------------------- Firestore compatibility

def test_encode_decode_roundtrip_and_firestore_rules():
    doc = {"J": np.eye(3).tolist(), "deep": [1, [2, [3, 4]], {"m": [[5]]}], "f": np.float32(1.5), "i": np.int64(7),
           "arr": np.arange(3), "t": datetime(2026, 1, 1, tzinfo=timezone.utc), "s": "x"}
    enc = st.encode(doc)
    st.check_document("t", enc)                      # no array directly inside an array, size ok
    assert type(enc["i"]) is int and type(enc["f"]) is float and enc["arr"] == [0, 1, 2]
    dec = st.decode(enc)
    assert dec["J"] == np.eye(3).tolist() and dec["deep"] == [1, [2, [3, 4]], {"m": [[5]]}]


def test_strict_store_rejects_oversized_documents(tmp_path):
    s = st.LocalStore(tmp_path / "x.json", strict=True)
    with pytest.raises(st.DocumentTooLarge):
        s.create("big", {"blob": "x" * 1_100_000})


def test_firestore_writer_encodes_nested_arrays():
    enc = st.FirestoreStore._in("jobs", {"ising": {"J": [[0.0, 1.0], [1.0, 0.0]]}})
    assert enc["ising"]["J"] == [{st.NESTED: [0.0, 1.0]}, {st.NESTED: [1.0, 0.0]}]


# ---------------------------------------------------------------- authorization / IDOR

def test_other_users_cannot_touch_my_resources():
    as_user("alice")
    exp = c.post("/v1/experiments", json={"source": "synthetic", "truth_bitstring": "10101011"}).json()["experiment"]
    job = c.post(f"/v1/experiments/{exp['id']}/jobs", json={"provider": "classical_exact"}).json()["job"]
    as_user("mallory")
    eid, jid = exp["id"], job["id"]
    assert c.get(f"/v1/experiments/{eid}").status_code == 404
    assert c.get(f"/v1/experiments/{eid}/export").status_code == 404
    assert c.get(f"/v1/experiments/{eid}/revisions").status_code == 404
    assert c.get(f"/v1/jobs/{jid}").status_code == 404
    assert c.post(f"/v1/jobs/{jid}/cancel").status_code == 404
    assert c.post(f"/v1/experiments/{eid}/jobs", json={"provider": "random"}).status_code == 404
    assert c.post("/v1/circuits/preview", json={"experiment_id": eid}).status_code == 404
    assert c.post(f"/v1/experiments/{eid}/snapshot", json={"png": "data:image/png;base64,iVBORw0KGgo="}).status_code == 404
    assert c.get(f"/v1/jobs?experiment_id={eid}").json()["jobs"] == []
    assert c.get(f"/v1/feed?experiment_id={eid}").json()["items"] == []
    assert c.get(f"/v1/artifacts/alice/{eid}/jobs/{jid}.png").status_code == 404
    assert c.post("/v1/experiments", json={"source": "openbci", "recording_id": "nope"}).status_code == 404


@pytest.mark.parametrize("path", ["dev/../alice/x.png", "dev/./x.png", "dev//x.png", "dev/x.json", "dev/..%2Fx.png"])
def test_artifact_paths_are_confined(path):
    assert c.get(f"/v1/artifacts/{path}", headers=DEV).status_code == 404


def test_snapshot_requires_real_png():
    exp = c.post("/v1/experiments", json={"source": "synthetic", "random_seed": 9}, headers=DEV).json()["experiment"]
    assert c.post(f"/v1/experiments/{exp['id']}/snapshot", headers=DEV, json={"png": "data:image/png;base64,aGVsbG8="}).status_code == 400


def test_internal_routes_hidden_on_public_service(monkeypatch):
    monkeypatch.setattr(appmod, "SERVICE_ROLE", "api")
    assert c.post("/internal/tasks", json={"job_id": "x", "step": "execute"}).status_code == 404


def test_malformed_task_payloads_are_rejected_without_retry():
    r = c.post("/internal/tasks", json={"job_id": "../../etc", "step": "execute"})
    assert r.status_code == 200 and "rejected" in r.json()
    assert c.post("/internal/tasks", json={"job_id": "abc", "step": "rm -rf"}).json().get("rejected")


def test_body_size_limit(monkeypatch):
    monkeypatch.setattr(appmod, "MAX_BODY_BYTES", 1000)
    r = c.post("/v1/experiments", headers=DEV, json={"source": "synthetic", "title": "x" * 2000})
    assert r.status_code == 413


def test_security_headers():
    r = c.get("/lab")
    if r.status_code == 200:
        csp = r.headers["content-security-policy"]
        assert "https://accounts.google.com/gsi/client" in csp and "frame-ancestors 'none'" in csp
        assert r.headers["cross-origin-opener-policy"] == "same-origin-allow-popups"
    assert c.get("/v1/config").headers["cache-control"] == "no-store"


def test_tracebacks_are_not_returned():
    exp = c.post("/v1/experiments", json={"source": "synthetic", "random_seed": 3}, headers=DEV).json()["experiment"]
    j = runner.create_job("dev", exp["id"], {"provider": "random"}, enqueue=False)
    store().update("jobs", j["id"], {"status": "failed", "traceback": "File /app/secret.py line 1"})
    assert "traceback" not in c.get(f"/v1/jobs/{j['id']}", headers=DEV).json()["job"]


# ---------------------------------------------------------------- cost abuse

def test_rate_limits_return_429_with_retry_after(monkeypatch):
    monkeypatch.setenv("LIMIT_PREVIEW", "1")
    as_user("ratey")
    exp = c.post("/v1/experiments", json={"source": "synthetic", "random_seed": 1}).json()["experiment"]
    body = {"experiment_id": exp["id"], "approximation": "secant", "spec": {"reps": 1, "max_couplings": 2}}
    assert c.post("/v1/circuits/preview", json=body).status_code == 200
    r = c.post("/v1/circuits/preview", json=body)
    assert r.status_code == 429 and int(r.headers["retry-after"]) > 0


def test_limit_zero_disables_and_negative_unlimits(monkeypatch):
    monkeypatch.setenv("LIMIT_SNAPSHOT", "0")
    with pytest.raises(limits.RateLimited):
        limits.consume("u0", "snapshot")
    monkeypatch.setenv("LIMIT_SNAPSHOT", "-1")
    for _ in range(50):
        limits.consume("u0", "snapshot")


def test_hardware_quota_per_account(monkeypatch):
    monkeypatch.setenv("HARDWARE_QUOTAS", "pi@lab.org:1")
    as_user("student", "student@lab.org")
    monkeypatch.setattr(runner, "provider_availability", lambda: [{"id": "ibm_quantum", "available": True}])
    exp = c.post("/v1/experiments", json={"source": "synthetic", "random_seed": 2}).json()["experiment"]
    assert c.post(f"/v1/experiments/{exp['id']}/jobs", json={"provider": "ibm_quantum"}).status_code == 429
    assert c.post("/v1/session", json={"allow_autonomous_qpu": True}).status_code == 403
    assert c.get("/v1/me").json()["hardware"]["limit"] == 0
    as_user("pi", "pi@lab.org")
    exp = c.post("/v1/experiments", json={"source": "synthetic", "random_seed": 2}).json()["experiment"]
    first = c.post(f"/v1/experiments/{exp['id']}/jobs", json={"provider": "ibm_quantum"})
    assert first.status_code in (200, 503)           # allowed + counted (queued, or refused later by the unconfigured backend)
    again = c.post(f"/v1/experiments/{exp['id']}/jobs", json={"provider": "ibm_quantum"})
    assert again.status_code == 429 and "jacobfv123@gmail.com" in again.json()["detail"]
    assert c.get("/v1/me").json()["hardware"] == {**c.get("/v1/me").json()["hardware"], "used": 1, "limit": 1}


def test_self_service_budgets_are_capped(monkeypatch):
    monkeypatch.setattr(appmod, "CAP_QPU_JOBS", 3)
    s = c.post("/v1/session", headers=DEV, json={"qpu_jobs_budget": 20}).json()
    assert s["qpu_jobs_budget"] == 3


# ---------------------------------------------------------------- device tokens

def test_device_token_revocation_and_expiry():
    tok = c.post("/v1/eeg/ingest-token", headers=DEV).json()["token"]
    hdr = {"Authorization": f"Bearer {tok}"}
    frame = {"fs": 250, "channel_names": ["Fp1"], "samples": [[0.0] * 250], "blink": True}
    assert c.post("/v1/eeg/ingest", json=frame, headers=hdr).status_code == 200
    assert c.post("/v1/eeg/ingest", json=frame, headers={"Authorization": tok}).status_code == 401   # scheme required
    listed = c.get("/v1/eeg/ingest-tokens", headers=DEV).json()["tokens"]
    assert listed and all(len(t["id"]) == 12 for t in listed)       # hash prefix only, never the token
    assert c.post("/v1/eeg/ingest-tokens/revoke", headers=DEV, json={}).json()["revoked"] >= 1
    assert c.post("/v1/eeg/ingest", json=frame, headers=hdr).status_code == 403
    tok2 = c.post("/v1/eeg/ingest-token", headers=DEV).json()["token"]
    store().update("ingest_tokens", hashlib.sha256(tok2.encode()).hexdigest(), {"expires_at": "2000-01-01T00:00:00+00:00"})
    assert c.post("/v1/eeg/ingest", json=frame, headers={"Authorization": f"Bearer {tok2}"}).status_code == 403


def test_recordings_live_in_object_storage_not_firestore():
    tok = c.post("/v1/eeg/ingest-token", headers=DEV).json()["token"]
    sig = (np.sin(np.arange(15000) / 10) * 20).tolist()
    data = [sig] * 8                                              # 120k samples: > 1 MiB as a Firestore array
    rid = c.post("/v1/eeg/recordings", headers={"Authorization": f"Bearer {tok}"},
                 json={"label": "big", "fs": 250, "channel_names": [f"c{i}" for i in range(8)], "data": data}).json()["recording_id"]
    doc = store().get("eeg_recordings", rid)
    assert "data" not in doc and doc["data_path"].endswith(".json.gz")
    exp = c.post("/v1/experiments", headers=DEV, json={"source": "openbci", "recording_id": rid, "channel": "c3"}).json()["experiment"]
    assert exp["target"]["source"] == "openbci"
    assert c.post("/v1/experiments", headers=DEV, json={"source": "openbci", "recording_id": rid, "channel": "zz"}).status_code == 404


# ---------------------------------------------------------------- job robustness

def test_cancel_wins_over_a_finishing_worker():
    exp = runner.create_experiment("dev", {"source": "synthetic", "truth_bitstring": "00110010"})
    job = runner.create_job("dev", exp["id"], {"provider": "classical_anneal"}, enqueue=False)
    assert runner.claim(job["id"], "queued", "running")
    runner.cancel_job("dev", job["id"])
    done = runner.execute_sample_job(store().get("jobs", job["id"]))
    assert done["status"] == "cancelled" and done["evaluation"]        # results kept, cancellation respected


def test_cancelled_hardware_job_is_not_submitted(monkeypatch):
    from cortex2 import backends

    calls = []

    class FakeQPU(backends.IBMRuntime):
        id = "fake_qpu"

        def availability(self):
            return True, None

        def submit(self, *a, **k):
            calls.append("submit")
            raise AssertionError("must not submit a cancelled job")

    monkeypatch.setitem(backends.REGISTRY, "fake_qpu", FakeQPU())
    monkeypatch.setitem(runner.PROVIDERS, "fake_qpu", {"label": "fake", "kind": "quantum_hardware"})
    monkeypatch.setattr(runner, "GATE_PROVIDERS", runner.GATE_PROVIDERS | {"fake_qpu"})
    exp = runner.create_experiment("dev", {"source": "synthetic", "truth_bitstring": "00110010"})
    job = runner.create_job("dev", exp["id"], {"provider": "fake_qpu", "spec": {"reps": 1, "max_couplings": 2}}, enqueue=False)
    runner.claim(job["id"], "queued", "running")
    runner.cancel_job("dev", job["id"])
    out = runner.execute_sample_job(store().get("jobs", job["id"]))
    assert out["status"] == "cancelled" and not calls


def test_transient_poll_errors_back_off_instead_of_failing(monkeypatch):
    from cortex2 import backends

    class Flaky(backends.IBMRuntime):
        id = "flaky_qpu"

        def poll(self, *a, **k):
            raise ConnectionError("provider API timeout")

    monkeypatch.setitem(backends.REGISTRY, "flaky_qpu", Flaky())
    queued = []
    monkeypatch.setattr(tasks, "enqueue", lambda *a, **k: queued.append((a, k)))
    exp = runner.create_experiment("dev", {"source": "synthetic", "truth_bitstring": "00110010"})
    jid = store().create("jobs", {"owner": "dev", "experiment_id": exp["id"], "kind": "sample", "provider": "flaky_qpu",
                                  "status": "submitted", "provider_job_id": "p1", "shots": 128, "created_at": st.now(),
                                  "approximation": "secant"})["id"]
    res = runner.handle_task({"job_id": jid, "step": "poll", "attempt": 1})
    job = store().get("jobs", jid)
    assert job["status"] == "submitted" and job["poll_errors"] == 1 and queued
    assert res["status"] == "submitted"
    store().update("jobs", jid, {"poll_errors": runner.MAX_POLL_ERRORS})
    runner.handle_task({"job_id": jid, "step": "poll", "attempt": 2})
    assert store().get("jobs", jid)["status"] == "failed"


def test_oversized_job_fields_are_offloaded(monkeypatch):
    exp = runner.create_experiment("dev", {"source": "synthetic", "truth_bitstring": "00110010"})
    job = runner.create_job("dev", exp["id"], {"provider": "random"}, enqueue=False)
    huge = {"operations": [{"gate": "rz", "qubits": [0], "params": [0.1]}] * 40000}
    runner.save_job(job["id"], {"isa_circuit": huge, "note": "ok"})
    saved = store().get("jobs", job["id"])
    assert saved["isa_circuit"] is None and saved["isa_circuit_path"].endswith(".json.gz") and saved["note"] == "ok"
    assert len(st.artifacts().get_json(saved["isa_circuit_path"])["operations"]) == 40000


def test_duplicate_task_delivery_runs_once():
    exp = runner.create_experiment("dev", {"source": "synthetic", "truth_bitstring": "00110010"})
    job = runner.create_job("dev", exp["id"], {"provider": "random"}, enqueue=False)
    first = runner.handle_task({"job_id": job["id"], "step": "execute"})
    second = runner.handle_task({"job_id": job["id"], "step": "execute"})
    assert first["status"] == "completed" and second == {"terminal": "completed"}

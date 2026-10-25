"""End-to-end through HTTP with the local store and in-process tasks."""
import time

from fastapi.testclient import TestClient

from cortex2.app import app

H = {"Authorization": "Bearer dev"}
c = TestClient(app)


def wait(job_id, timeout=120):
    end = time.time() + timeout
    while time.time() < end:
        j = c.get(f"/v1/jobs/{job_id}", headers=H).json()["job"]
        if j["status"] in ("completed", "failed", "cancelled"):
            return j
        time.sleep(0.25)
    raise AssertionError("job did not finish")


def test_config_is_public_and_honest():
    cfg = c.get("/v1/config").json()
    prov = {p["id"]: p for p in cfg["providers"]}
    assert prov["ibm_quantum"]["available"] is False and "IBM_QUANTUM_TOKEN" in prov["ibm_quantum"]["reason"]
    assert cfg["agent_configured"] is False and cfg["auth"]["dev_auth"] is True


def test_auth_required():
    assert c.get("/v1/experiments").status_code == 401
    assert c.get("/v1/experiments", headers={"Authorization": "Bearer nope"}).status_code in (401, 503)


def test_full_pipeline_synthetic():
    exp = c.post("/v1/experiments", json={"source": "synthetic", "truth_bitstring": "10101011"}, headers=H).json()["experiment"]
    assert exp["target"]["truth_bitstring"] == "10101011"
    prev = c.post("/v1/circuits/preview", headers=H, json={"experiment_id": exp["id"], "approximation": "trust_region",
                                                             "spec": {"reps": 1, "max_couplings": 6}}).json()
    assert prev["transpiled"]["gates"] > 0 and prev["circuit"]["qubits"] == 8
    job = c.post(f"/v1/experiments/{exp['id']}/jobs", headers=H, json={"provider": "aer_noisy", "approximation": "trust_region",
                                                                      "spec": {"reps": 1, "max_couplings": 6}, "shots": 512}).json()["job"]
    done = wait(job["id"])
    assert done["status"] == "completed", done.get("error")
    assert done["evaluation"]["shots"] == 512 and done["transpiled"]["backend"]
    assert done["image"]
    img = c.get(f"/v1/artifacts/{done['image']}", headers=H)
    assert img.status_code == 200 and img.content.startswith(b"\x89PNG")
    full = c.get(f"/v1/experiments/{exp['id']}", headers=H).json()
    assert full["experiment"]["best"] and len(full["landscape"]["nonlinear_loss"]) == 256
    assert full["experiment"]["baseline"] == full["experiment"]["best"]["bitstring"]
    for provider in ("classical_exact", "classical_anneal", "thrml"):
        j = c.post(f"/v1/experiments/{exp['id']}/jobs", headers=H, json={"provider": provider, "approximation": "trust_region"}).json()["job"]
        assert wait(j["id"])["status"] == "completed"
    exact = [j for j in c.get(f"/v1/jobs?experiment_id={exp['id']}", headers=H).json()["jobs"] if j["provider"] == "classical_exact"][0]
    assert exact["evaluation"]["truth"]["recovered_exactly"]
    assert c.get(f"/v1/feed?experiment_id={exp['id']}", headers=H).json()["items"]
    assert c.get(f"/v1/experiments/{exp['id']}/export", headers=H).json()["reproducibility"]


def test_unavailable_provider_and_agent_are_refused():
    exp = c.post("/v1/experiments", json={"source": "synthetic", "random_seed": 4}, headers=H).json()["experiment"]
    r = c.post(f"/v1/experiments/{exp['id']}/jobs", headers=H, json={"provider": "ibm_quantum"})
    assert r.status_code == 503
    assert c.post(f"/v1/experiments/{exp['id']}/agent/iterate", headers=H, json={}).status_code == 503


def test_recording_experiment_and_eeg_ingest():
    ds = c.get("/v1/datasets", headers=H).json()["datasets"][0]
    assert ds["segments"] == ["preictal", "ictal", "postictal"]  # contract: list of names
    exp = c.post("/v1/experiments", headers=H, json={"source": "recording", "dataset_id": ds["id"], "channel": "T7-P7", "segment": "ictal"}).json()["experiment"]
    assert exp["target"]["weights"][-1] == 0 and exp["target"]["truth_bitstring"] is None
    tok = c.post("/v1/eeg/ingest-token", headers=H).json()["token"]
    frame = {"board": "synthetic", "fs": 250, "channel_names": ["Fp1"], "samples": [[0.0] * 250], "bands": {"alpha": 40}, "blink": True}
    assert c.post("/v1/eeg/ingest", json=frame, headers={"Authorization": f"Bearer {tok}"}).status_code == 200
    assert c.post("/v1/eeg/ingest", json=frame, headers={"Authorization": "Bearer wrong"}).status_code == 403
    latest = c.get("/v1/eeg/latest", headers=H).json()
    assert latest["live"] and latest["frame"]["blink"] is True
    import numpy as np
    sig = (np.sin(2 * np.pi * 10 * np.arange(2500) / 250) * 20).tolist()
    rid = c.post("/v1/eeg/recordings", headers={"Authorization": f"Bearer {tok}"},
                 json={"label": "eyes closed", "fs": 250, "channel_names": ["O1"], "data": [sig]}).json()["recording_id"]
    e2 = c.post("/v1/experiments", headers=H, json={"source": "openbci", "recording_id": rid}).json()["experiment"]
    assert e2["target"]["source"] == "openbci"


def test_verdict_logic():
    from cortex2.agent import verdict
    mk = lambda loss, pc, g=100: {"evaluation": {"best_nonlinear_loss": loss, "p_consistent": pc}, "transpiled": {"gates": g, "within_budget": True}}
    assert verdict(mk(1.0, .1), mk(0.5, .1)) == "improved"
    assert verdict(mk(0.5, .1), mk(1.0, .9)) == "regressed"
    assert verdict(mk(0.5, .1), mk(0.5, .3)) == "improved"
    assert verdict(mk(0.5, .1), mk(0.5, .1)) == "unchanged"
    assert verdict(None, mk(0.5, .1)) == "untested"


def test_cancel_during_execution_is_not_resurrected():
    from cortex2 import runner
    from cortex2.store import store
    exp = c.post("/v1/experiments", json={"source": "synthetic", "truth_bitstring": "00110010"}, headers=H).json()["experiment"]
    job = runner.create_job("dev", exp["id"], {"provider": "classical_anneal", "approximation": "secant"}, enqueue=False)
    store().update("jobs", job["id"], {"status": "running"})
    assert c.post(f"/v1/jobs/{job['id']}/cancel", headers=H).json()["job"]["status"] == "cancelled"
    done = runner.execute_sample_job(store().get("jobs", job["id"]))     # worker finishes afterwards
    assert done["status"] == "cancelled"
    assert c.get(f"/v1/experiments/{exp['id']}", headers=H).json()["experiment"]["best"] is None

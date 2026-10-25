"""IonQ trapped-ion execution via the IonQ Cloud REST API v0.4 (no SDK dependency).

Trapped ions have all-to-all connectivity: every ZZ coupling of the Ising model is one native
two-qubit interaction, with no SWAP routing. A full (unpruned) 8-qubit QAOA layer therefore
fits the physical gate budget on IonQ, whereas IBM heavy-hex needs pruning — a hardware
choice the agent can reason about. Circuits are submitted in IonQ's "qis" gateset; IonQ
compiles them to native GPi/GPi2/MS gates server-side.

Conventions (verified empirically against the IonQ simulator, see tests/test_hardware_calibration.py):
  * result keys are integer basis states with qubit 0 as the least-significant bit — identical to
    our bitstrings after format(k, "08b");
  * qis `zz`/`rx`/`ry`/`rz` take `rotation` in radians with Qiskit's semantics,
    e.g. zz(θ) = exp(-i θ/2 Z⊗Z) = Qiskit RZZ(θ).
"""
from __future__ import annotations

import os
import time
from functools import lru_cache

import requests

from . import neural as nm

API = (os.environ.get("IONQ_API_URL") or "https://api.ionq.co/v0.4").rstrip("/")
ROOT = API.rsplit("/v0.", 1)[0]
DEFAULT_QPU = "qpu.forte-1"
DEFAULT_NOISE = "forte-1"
NOISE_MODELS = ("ideal", "aria-1", "aria-2", "forte-1", "forte-enterprise-1")
QIS_BASIS = ["x", "y", "z", "h", "s", "sdg", "t", "tdg", "sx", "sxdg", "rx", "ry", "rz", "cx", "rzz", "rxx", "ryy", "swap"]
_NAME = {"sdg": "si", "tdg": "ti", "sx": "v", "sxdg": "vi", "cx": "cnot", "rzz": "zz", "rxx": "xx", "ryy": "yy"}
TERMINAL_FAIL = ("failed", "canceled", "cancelled")


def configured() -> bool:
    return bool(os.environ.get("IONQ_API_KEY"))


def qpu_backend() -> str:
    return os.environ.get("IONQ_QPU_BACKEND") or DEFAULT_QPU


def noise_model() -> str:
    m = os.environ.get("IONQ_NOISE_MODEL") or DEFAULT_NOISE
    return m if m in NOISE_MODELS else DEFAULT_NOISE


def _headers() -> dict:
    key = os.environ.get("IONQ_API_KEY")
    if not key:
        raise RuntimeError("IONQ_API_KEY is not configured")
    return {"Authorization": f"apiKey {key}", "Content-Type": "application/json"}


def _check(r: requests.Response, what: str) -> dict:
    if r.status_code >= 400:
        raise RuntimeError(f"IonQ {what} failed ({r.status_code}): {r.text[:400]}")
    return r.json()


@lru_cache(maxsize=1)
def _backends_cached(_minute: int) -> list[dict]:
    # v0.3 still reports per-key `has_access`; v0.4 omits it.
    return _check(requests.get(f"{ROOT}/v0.3/backends", headers=_headers(), timeout=30), "backends")


def backends() -> list[dict]:
    return _backends_cached(int(time.time() // 600))


def qpu_access() -> tuple[bool, str | None]:
    """Whether this API key may run on the configured QPU (cached ~10 min)."""
    if not configured():
        return False, "IONQ_API_KEY is not configured on the server"
    name = qpu_backend()
    try:
        info = {b["backend"]: b for b in backends()}.get(name)
    except Exception as exc:
        return False, f"IonQ backend list unavailable: {exc}"
    if info is None:
        return False, f"{name} is not an IonQ backend"
    if info.get("status") not in ("available", "reserved", "calibrating"):
        return False, f"{name} is {info.get('status')}"
    if info.get("has_access") is False:
        return False, f"this IonQ API key has no access to {name} (simulator only)"
    return True, None


def to_qis(qc):
    """Transpile to IonQ's qis gateset with all-to-all connectivity; returns (circuit, json gates, stats)."""
    from qiskit import transpile

    from .quantum import GATE_BUDGET, gate_stats

    t = transpile(qc.remove_final_measurements(inplace=False), basis_gates=QIS_BASIS, optimization_level=2, seed_transpiler=11)
    gates = []
    for inst in t.data:
        op, qubits = inst.operation, [t.find_bit(q).index for q in inst.qubits]
        if op.name in ("barrier", "measure"):
            continue
        g: dict = {"gate": _NAME.get(op.name, op.name)}
        if op.name in ("rzz", "rxx", "ryy", "swap"):
            g["targets"] = qubits
        elif op.name == "cx":
            g["control"], g["target"] = qubits
        else:
            g["target"] = qubits[0]
        if op.params:
            g["rotation"] = float(op.params[0])
        gates.append(g)
    stats = gate_stats(t)
    stats.update({"backend": "ionq (all-to-all, qis)", "physical_qubits": list(range(nm.N_BITS)),
                  "within_budget": stats["gates"] <= GATE_BUDGET, "budget": GATE_BUDGET,
                  "note": "IonQ compiles qis gates to native GPi/GPi2/MS server-side; two-qubit count is exact, no SWAPs"})
    return t, gates, stats


def job_body(gates: list[dict], shots: int, backend: str, noise: str | None = None, name: str = "cortex2",
             dry_run: bool = False) -> dict:
    body = {"type": "ionq.circuit.v1", "backend": backend, "shots": int(shots), "name": name[:100],
            "input": {"qubits": nm.N_BITS, "gateset": "qis", "circuit": gates}}
    if backend == "simulator":
        body["noise"] = {"model": noise or "ideal"}
    if dry_run:
        body["dry_run"] = True
    return body


def submit(qc, shots: int, backend: str, noise: str | None = None, name: str = "cortex2", dry_run: bool = False) -> dict:
    _, gates, stats = to_qis(qc)
    job = _check(requests.post(f"{API}/jobs", json=job_body(gates, shots, backend, noise, name, dry_run),
                               headers=_headers(), timeout=60), "submit")
    label = backend + (f" (noise {noise or 'ideal'})" if backend == "simulator" else "")
    return {"provider_job_id": job["id"], "backend": label, "transpiled": stats, "provider_status": job.get("status"),
            "dry_run": dry_run}


def estimate(qc, shots: int, backend: str | None = None) -> dict:
    """Cost / time estimate for running `qc` on a QPU (no job is created)."""
    _, _, stats = to_qis(qc)
    twoq = stats["two_qubit_gates"]
    params = {"backend": backend or qpu_backend(), "qubits": nm.N_BITS, "shots": int(shots),
              "1q_gates": max(0, stats["gates"] - twoq), "2q_gates": twoq}
    est = _check(requests.get(f"{API}/jobs/estimate", params=params, headers=_headers(), timeout=30), "estimate")
    return {"backend": params["backend"], "shots": shots, "1q_gates": params["1q_gates"], "2q_gates": twoq,
            "estimated_total_cost": est.get("estimated_total_cost"), "unit": est.get("estimated_unit"),
            "estimated_execution_ms": est.get("estimated_execution_time"),
            "predicted_queue_ms": est.get("current_predicted_queue_time")}


def probabilities_to_counts(probs: dict, shots: int) -> dict[str, int]:
    """Largest-remainder rounding so the counts sum exactly to `shots`."""
    items = [(format(int(k), f"0{nm.N_BITS}b"), float(p) * shots) for k, p in probs.items()]
    counts = {s: int(v) for s, v in items}
    short = shots - sum(counts.values())
    for s, v in sorted(items, key=lambda kv: -(kv[1] - int(kv[1])))[:max(0, short)]:
        counts[s] += 1
    return {s: n for s, n in counts.items() if n}


def poll(job_id: str, shots: int) -> dict:
    job = _check(requests.get(f"{API}/jobs/{job_id}", headers=_headers(), timeout=30), "status")
    status = job.get("status", "")
    if status == "completed":
        url = ((job.get("results") or {}).get("probabilities") or {}).get("url") or f"/v0.4/jobs/{job_id}/results/probabilities"
        probs = _check(requests.get(ROOT + url, headers=_headers(), timeout=60), "results")
        return {"status": "done", "counts": probabilities_to_counts(probs, shots),
                "execution_time_ms": job.get("execution_duration_ms"), "gate_counts": (job.get("stats") or {}).get("gate_counts"),
                "cost_model": job.get("cost_model")}
    if status in TERMINAL_FAIL:
        failure = job.get("failure") or {}
        detail = failure.get("error") or failure.get("message") or failure or ""
        return {"status": "failed", "error": f"IonQ job {status}: {detail}"}
    return {"status": "pending", "provider_status": status}


def run_blocking(qc, shots: int, noise: str | None, timeout: float = 240) -> tuple[dict[str, int], dict]:
    """Simulator path: submit and wait (the IonQ cloud simulator usually returns in seconds)."""
    sub = submit(qc, shots, "simulator", noise)
    deadline = time.monotonic() + timeout
    delay = 1.0
    while time.monotonic() < deadline:
        time.sleep(delay)
        res = poll(sub["provider_job_id"], shots)
        if res["status"] == "done":
            return res["counts"], {"mode": "ionq_cloud_simulator", "noise_model": noise or "ideal",
                                   "provider_job_id": sub["provider_job_id"], "backend": sub["backend"],
                                   "gate_counts": res.get("gate_counts")}
        if res["status"] == "failed":
            raise RuntimeError(res["error"])
        delay = min(5.0, delay * 1.5)
    raise TimeoutError(f"IonQ simulator job {sub['provider_job_id']} did not finish in {timeout:.0f}s")


def cancel(job_id: str) -> None:
    r = requests.put(f"{API}/jobs/{job_id}/status/cancel", headers=_headers(), timeout=30)
    if r.status_code >= 400:
        raise RuntimeError(f"IonQ cancel failed ({r.status_code}): {r.text[:200]}")

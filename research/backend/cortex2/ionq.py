"""IonQ trapped-ion execution via the IonQ Cloud REST API (no SDK dependency).

Trapped ions have all-to-all connectivity: every ZZ coupling of the Ising model is one native
two-qubit interaction, with no SWAP routing. A full (unpruned) 8-qubit QAOA layer therefore
fits the physical gate budget on IonQ, whereas IBM heavy-hex needs pruning — a hardware
choice the agent can reason about. Circuits are submitted in IonQ's "qis" gateset; IonQ
compiles them to native GPi/GPi2/MS gates server-side.
"""
from __future__ import annotations

import math
import os
import time

import requests

from . import neural as nm

API = os.environ.get("IONQ_API_URL", "https://api.ionq.co/v0.3")
QIS_BASIS = ["x", "y", "z", "h", "s", "sdg", "t", "tdg", "sx", "sxdg", "rx", "ry", "rz", "cx", "rzz", "rxx", "ryy", "swap"]
_NAME = {"sdg": "si", "tdg": "ti", "sx": "v", "sxdg": "vi", "cx": "cnot", "rzz": "zz", "rxx": "xx", "ryy": "yy"}


def configured() -> bool:
    return bool(os.environ.get("IONQ_API_KEY"))


def _headers() -> dict:
    key = os.environ.get("IONQ_API_KEY")
    if not key:
        raise RuntimeError("IONQ_API_KEY is not configured")
    return {"Authorization": f"apiKey {key}", "Content-Type": "application/json"}


def to_qis(qc):
    """Transpile to IonQ's qis gateset with all-to-all connectivity; returns (circuit, json gates, stats)."""
    from qiskit import transpile

    from .quantum import gate_stats

    t = transpile(qc.remove_final_measurements(inplace=False), basis_gates=QIS_BASIS, optimization_level=2, seed_transpiler=11)
    gates = []
    for inst in t.data:
        op, qubits = inst.operation, [t.find_bit(q).index for q in inst.qubits]
        if op.name in ("barrier", "measure"):
            continue
        name = _NAME.get(op.name, op.name)
        g: dict = {"gate": name}
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
                  "note": "IonQ compiles qis gates to native GPi/GPi2/MS server-side; two-qubit count is exact, no SWAPs"})
    from .quantum import GATE_BUDGET

    stats["within_budget"], stats["budget"] = stats["gates"] <= GATE_BUDGET, GATE_BUDGET
    return t, gates, stats


def submit(qc, shots: int, target: str, noise_model: str | None = None, name: str = "cortex2") -> dict:
    _, gates, stats = to_qis(qc)
    body = {"target": target, "shots": int(shots), "name": name[:100],
            "input": {"format": "ionq.circuit.v0", "gateset": "qis", "qubits": nm.N_BITS, "circuit": gates}}
    if target == "simulator" and noise_model and noise_model != "ideal":
        body["noise"] = {"model": noise_model}
    r = requests.post(f"{API}/jobs", json=body, headers=_headers(), timeout=60)
    if r.status_code >= 400:
        raise RuntimeError(f"IonQ submit failed ({r.status_code}): {r.text[:400]}")
    job = r.json()
    return {"provider_job_id": job["id"], "backend": target + (f" (noise {noise_model})" if target == "simulator" else ""),
            "transpiled": stats, "provider_status": job.get("status")}


def poll(job_id: str, shots: int) -> dict:
    r = requests.get(f"{API}/jobs/{job_id}", headers=_headers(), timeout=30)
    if r.status_code >= 400:
        raise RuntimeError(f"IonQ status failed ({r.status_code}): {r.text[:300]}")
    job = r.json()
    status = job.get("status", "")
    if status == "completed":
        rr = requests.get(f"{API}/jobs/{job_id}/results", headers=_headers(), timeout=60)
        if rr.status_code >= 400:
            raise RuntimeError(f"IonQ results failed ({rr.status_code}): {rr.text[:300]}")
        probs = rr.json()
        # keys are integer basis states, qubit 0 = least significant bit → same as our bitstrings
        counts: dict[str, int] = {}
        for k, p in probs.items():
            n = int(round(float(p) * shots))
            if n:
                counts[format(int(k), f"0{nm.N_BITS}b")] = n
        return {"status": "done", "counts": counts, "execution_time_ms": job.get("execution_time"),
                "predicted_execution_time": job.get("predicted_execution_time")}
    if status in ("failed", "canceled", "cancelled"):
        failure = job.get("failure") or {}
        return {"status": "failed", "error": f"IonQ job {status}: {failure.get('error') or failure or ''}"}
    return {"status": "pending", "provider_status": status}


def run_blocking(qc, shots: int, noise_model: str | None, timeout: float = 240) -> tuple[dict[str, int], dict]:
    """Simulator path: submit and wait (IonQ cloud simulator usually returns in seconds)."""
    sub = submit(qc, shots, "simulator", noise_model)
    deadline = time.monotonic() + timeout
    delay = 1.0
    while time.monotonic() < deadline:
        time.sleep(delay)
        res = poll(sub["provider_job_id"], shots)
        if res["status"] == "done":
            return res["counts"], {"mode": "ionq_cloud_simulator", "noise_model": noise_model or "ideal",
                                   "provider_job_id": sub["provider_job_id"], "transpiled": sub["transpiled"]}
        if res["status"] == "failed":
            raise RuntimeError(res["error"])
        delay = min(5.0, delay * 1.5)
    raise TimeoutError(f"IonQ simulator job {sub['provider_job_id']} did not finish in {timeout:.0f}s")


def cancel(job_id: str) -> None:
    requests.put(f"{API}/jobs/{job_id}/status/cancel", headers=_headers(), timeout=30)


def round_counts_total(counts: dict[str, int]) -> int:
    return int(math.fsum(counts.values()))

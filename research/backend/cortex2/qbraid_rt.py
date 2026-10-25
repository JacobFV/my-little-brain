"""qBraid: one API key, many vendors' simulators and QPUs (IonQ, Rigetti, IQM, AQT, QuEra, AWS, qBraid GPU sims).

The agent picks a concrete qBraid device id (e.g. "qbraid:qbraid:sim:qir-sv", "rigetti:rigetti:qpu:cepheus-1-108q")
through the `qbraid_device` spec option; qBraid converts our Qiskit circuit to the device's native program format and
transpiles it server-side. Result keys are bitstrings with qubit 0 as the rightmost character — identical to our
convention (verified on qir-sv and the IonQ simulator).
"""
from __future__ import annotations

import os
import time
from functools import lru_cache

DEFAULT_SIM = "qbraid:qbraid:sim:qir-sv"
DEFAULT_QPU = "rigetti:rigetti:qpu:cepheus-1-108q"
TERMINAL_FAIL = ("FAILED", "CANCELLED")


def configured() -> bool:
    return bool(os.environ.get("QBRAID_API_KEY"))


def sim_device() -> str:
    return os.environ.get("QBRAID_SIM_DEVICE") or DEFAULT_SIM


def qpu_device() -> str:
    return os.environ.get("QBRAID_QPU_DEVICE") or DEFAULT_QPU


def _provider():
    from qbraid.runtime import QbraidProvider

    return QbraidProvider(api_key=os.environ["QBRAID_API_KEY"])


@lru_cache(maxsize=1)
def _devices_cached(_slot: int) -> list[dict]:
    out = []
    for d in _provider().get_devices():
        try:
            status = d.status().name
        except Exception:
            status = "UNKNOWN"
        out.append({"id": d.id, "status": status, "simulator": bool(d.profile.get("simulator")), "qubits": d.num_qubits})
    return out


def devices() -> list[dict]:
    """Devices this key can see (cached 10 min)."""
    return _devices_cached(int(time.time() // 600))


def online(simulator: bool) -> list[str]:
    try:
        return [d["id"] for d in devices() if d["simulator"] == simulator and d["status"] == "ONLINE" and (d["qubits"] or 99) >= 8]
    except Exception:
        return []


def availability(simulator: bool) -> tuple[bool, str | None]:
    if not configured():
        return False, "QBRAID_API_KEY is not configured on the server"
    dev = sim_device() if simulator else qpu_device()
    try:
        info = {d["id"]: d for d in devices()}.get(dev)
    except Exception as exc:
        return False, f"qBraid device list unavailable: {str(exc)[:160]}"
    if info is None:
        return False, f"{dev} is not visible to this qBraid key"
    if info["status"] != "ONLINE":
        return False, f"{dev} is {info['status'].lower()}"
    return True, None


def resolve(options: dict, simulator: bool) -> str:
    dev = options.get("qbraid_device") or (sim_device() if simulator else qpu_device())
    kind = ":sim:" if simulator else ":qpu:"
    if kind not in dev:
        raise ValueError(f"{dev} is not a qBraid {'simulator' if simulator else 'QPU'} device")
    return dev


def submit(qc, shots: int, device: str) -> dict:
    job = _provider().get_device(device).run(qc, shots=int(shots))
    return {"provider_job_id": job.id, "backend": device}


def _counts(result) -> dict[str, int]:
    from . import neural as nm

    raw = result.data.get_counts()
    return {k.replace(" ", "").zfill(nm.N_BITS)[-nm.N_BITS:]: int(v) for k, v in raw.items()}


def poll(job_id: str, shots: int) -> dict:
    from qbraid.runtime import QbraidJob

    job = QbraidJob(job_id)
    status = job.status().name
    if status == "COMPLETED":
        return {"status": "done", "counts": _counts(job.result())}
    if status in TERMINAL_FAIL:
        return {"status": "failed", "error": f"qBraid job {status.lower()}"}
    return {"status": "pending", "provider_status": status.lower()}


def run_blocking(qc, shots: int, device: str, timeout: float = 300) -> tuple[dict[str, int], dict]:
    sub = submit(qc, shots, device)
    deadline, delay = time.monotonic() + timeout, 2.0
    while time.monotonic() < deadline:
        time.sleep(delay)
        res = poll(sub["provider_job_id"], shots)
        if res["status"] == "done":
            return res["counts"], {"mode": "qbraid_simulator", "device": device, "provider_job_id": sub["provider_job_id"]}
        if res["status"] == "failed":
            raise RuntimeError(res["error"])
        delay = min(6.0, delay * 1.4)
    raise TimeoutError(f"qBraid job {sub['provider_job_id']} did not finish in {timeout:.0f}s")


def cancel(job_id: str) -> None:
    from qbraid.runtime import QbraidJob

    QbraidJob(job_id).cancel()

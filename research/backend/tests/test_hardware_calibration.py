"""Live convention checks against real provider APIs.

Skipped unless CORTEX_HARDWARE_TESTS=1 and the keys are present (they make real, free cloud calls):

    CORTEX_HARDWARE_TESTS=1 IONQ_API_KEY=… IBM_QUANTUM_TOKEN=… pytest tests/test_hardware_calibration.py
"""
import math
import os
import time

import pytest
import requests

from cortex2 import ionq, quantum as qm

LIVE = os.environ.get("CORTEX_HARDWARE_TESTS") == "1"


@pytest.mark.skipif(not (LIVE and os.environ.get("IONQ_API_KEY")), reason="live IonQ test disabled")
def test_ionq_bit_order_and_rotation_conventions():
    """X on q0,q3; H·ZZ(π/3)·H on q1,q2; RX(π/3) on q5 → Qiskit semantics and qubit 0 = LSB."""
    th = math.pi / 3
    gates = [{"gate": "x", "target": 0}, {"gate": "x", "target": 3},
             {"gate": "h", "target": 1}, {"gate": "h", "target": 2},
             {"gate": "zz", "targets": [1, 2], "rotation": th},
             {"gate": "h", "target": 1}, {"gate": "h", "target": 2},
             {"gate": "rx", "target": 5, "rotation": th}]
    job = requests.post(f"{ionq.API}/jobs", json=ionq.job_body(gates, 1000, "simulator", "ideal", "cortex2 calibration test"),
                        headers=ionq._headers(), timeout=60).json()
    for _ in range(60):
        res = ionq.poll(job["id"], 10_000)
        if res["status"] != "pending":
            break
        time.sleep(1)
    assert res["status"] == "done", res
    p = {k: v / 10_000 for k, v in res["counts"].items()}
    assert all(s[-1] == "1" and s[-4] == "1" for s in p)                       # qubits 0 and 3 always set
    p11 = sum(v for s, v in p.items() if s[-2] == "1" and s[-3] == "1")
    assert abs(p11 - math.sin(th / 2) ** 2) < 0.02                             # zz(θ) = exp(-iθ/2 ZZ) → 0.25
    p5 = sum(v for s, v in p.items() if s[-6] == "1")
    assert abs(p5 - math.sin(th / 2) ** 2) < 0.02                              # rx(θ) Qiskit convention → 0.25


@pytest.mark.skipif(not (LIVE and os.environ.get("IBM_QUANTUM_TOKEN")), reason="live IBM test disabled")
def test_ibm_service_backends_and_quota():
    backends = qm.ibm_backends()
    assert backends and all(b["qubits"] >= 8 for b in backends)
    quota = qm.ibm_quota(block=True)
    assert quota and "limit_reached" in quota

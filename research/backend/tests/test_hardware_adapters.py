"""Offline checks of the hardware adapters (no network)."""
import numpy as np

from cortex2 import backends, inverse as inv, ionq, quantum as qm, runner


def _circuit(spec):
    exp = {"target": inv.synthetic_target("10101011").to_json(), "baseline": "00000000", "owner": "x", "id": "x"}
    target, q, ising, _ = runner.build_problem(exp, "trust_region", "00000000")
    qc, _, _ = runner.compile_circuit(ising, q, spec)
    return qc


def test_ionq_qis_keeps_all_couplings_native():
    qc = _circuit({"reps": 1})
    t, gates, stats = ionq.to_qis(qc)
    zz = [g for g in gates if g["gate"] == "zz"]
    assert len(zz) == 28 and all(len(g["targets"]) == 2 for g in zz)       # all-to-all: one gate per coupling
    assert stats["two_qubit_gates"] == 28 and stats["within_budget"]
    # the qis circuit is the same unitary as the logical one
    from qiskit.quantum_info import Operator
    assert Operator(t).equiv(Operator(qc.remove_final_measurements(inplace=False)))


def test_ionq_job_body_v04():
    body = ionq.job_body([{"gate": "h", "target": 0}], 100, "simulator", "forte-1", dry_run=True)
    assert body["type"] == "ionq.circuit.v1" and body["backend"] == "simulator"
    assert body["noise"] == {"model": "forte-1"} and body["dry_run"] is True
    assert body["input"] == {"qubits": 8, "gateset": "qis", "circuit": [{"gate": "h", "target": 0}]}
    qpu = ionq.job_body([], 10, "qpu.forte-1")
    assert "noise" not in qpu and "dry_run" not in qpu


def test_ionq_probabilities_to_counts_endianness_and_total():
    counts = ionq.probabilities_to_counts({"9": 0.5623, "15": 0.1876, "41": 0.1875, "47": 0.0626}, 1024)
    assert sum(counts.values()) == 1024
    assert set(counts) == {"00001001", "00001111", "00101001", "00101111"}   # integer key, qubit 0 = LSB


def test_ionq_qpu_unavailable_without_access(monkeypatch):
    monkeypatch.setenv("IONQ_API_KEY", "k")
    monkeypatch.setenv("IONQ_QPU_BACKEND", "qpu.forte-1")
    monkeypatch.setattr(ionq, "backends", lambda: [{"backend": "qpu.forte-1", "status": "available", "has_access": False},
                                                   {"backend": "qpu.aria-1", "status": "retired"}])
    ok, reason = backends.get("ionq_qpu").availability()
    assert not ok and "no access" in reason
    monkeypatch.setenv("IONQ_QPU_BACKEND", "qpu.aria-1")
    assert "retired" in backends.get("ionq_qpu").availability()[1]


def test_ibm_quota_exhaustion_blocks_availability_and_submit(monkeypatch):
    monkeypatch.setenv("IBM_QUANTUM_TOKEN", "t")
    monkeypatch.setitem(qm._QUOTA, "state", {"limit_reached": True, "limit_seconds": 600, "available_at": "2026-11-07"})
    monkeypatch.setitem(qm._QUOTA, "checked", 1e18)
    ok, reason = backends.get("ibm_quantum").availability()
    assert not ok and "2026-11-07" in reason
    try:
        qm.submit_ibm(_circuit({"reps": 1, "max_couplings": 6}))
    except RuntimeError as exc:
        assert "exhausted" in str(exc)
    else:
        raise AssertionError("submit must refuse when the quota is exhausted")


def test_registry_reports_hardware_and_modes():
    assert set(backends.ids(hardware=True)) == {"ibm_quantum", "ionq_qpu", "qbraid_qpu"}
    assert set(backends.ids(mode="async")) == {"ibm_quantum", "ionq_qpu", "qbraid_qpu"}
    assert "ionq_simulator" in backends.ids(paradigm="gate", mode="sync")
    assert np.isfinite(len(backends.agent_brief()))

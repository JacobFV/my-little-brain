"""Gate-model execution: QAOA construction, agent-authored QASM, transpilation, simulators, IBM Runtime.

Circuits come from two places:
  * `CircuitSpec` – a structured QAOA design (reps, angles, pruning, warm start) that the agent edits;
  * OpenQASM 2 text written directly by the agent, parsed (never executed as Python) and validated.

The ~130-gate budget applies to the *transpiled physical* circuit on a real IBM target, which is
reported alongside the logical counts and two-qubit depth.
"""
from __future__ import annotations

import os
import time
from dataclasses import asdict, dataclass, field
from functools import lru_cache

import numpy as np

from . import neural as nm
from .inverse import Ising

GATE_BUDGET = 130
MAX_QASM_CHARS = 60_000
MAX_LOGICAL_OPS = 4_000
DEFAULT_SHOTS = 1024
OFFLINE_TARGET = (os.environ.get("OFFLINE_TARGET") or "fake_torino")


@dataclass
class CircuitSpec:
    reps: int = 1
    gammas: list[float] | None = None        # None → optimise classically on the statevector
    betas: list[float] | None = None
    prune_threshold: float = 0.0             # drop |J_ij| < threshold * max|coef| couplings
    max_couplings: int | None = None         # keep at most this many strongest couplings
    warm_start: str | None = None            # bitstring to bias the initial state toward
    warm_epsilon: float = 0.25               # warm-start regularisation (Egger et al. 2021)
    coupling_order: str = "strength"         # strength | greedy_coloring (parallel layers)
    optimization_level: int = 3
    seed_transpiler: int = 11

    @classmethod
    def from_json(cls, d: dict | None) -> "CircuitSpec":
        d = dict(d or {})
        allowed = {f for f in cls.__dataclass_fields__}
        spec = cls(**{k: v for k, v in d.items() if k in allowed})
        spec.reps = int(min(max(spec.reps, 1), 4))
        spec.optimization_level = int(min(max(spec.optimization_level, 0), 3))
        spec.prune_threshold = float(min(max(spec.prune_threshold, 0.0), 1.0))
        if spec.warm_start is not None and (len(spec.warm_start) != nm.N_BITS or set(spec.warm_start) - {"0", "1"}):
            raise ValueError("warm_start must be an 8-character bitstring")
        return spec

    def to_json(self) -> dict:
        return asdict(self)


# ---------------------------------------------------------------- numpy QAOA (angle search)

def _z_values() -> np.ndarray:
    """z_i(k) = +1 if bit i of state k is 0 else -1."""
    return 1 - 2 * nm.all_bits()


def kept_couplings(ising: Ising, spec: CircuitSpec) -> list[tuple[int, int, float]]:
    scale = ising.scale()
    pairs = [c for c in ising.couplings() if abs(c[2]) >= spec.prune_threshold * scale]
    pairs.sort(key=lambda c: -abs(c[2]))
    if spec.max_couplings is not None:
        pairs = pairs[: max(0, int(spec.max_couplings))]
    if spec.coupling_order == "greedy_coloring":
        layers: list[list[tuple[int, int, float]]] = []
        for c in pairs:
            for layer in layers:
                if all(c[0] not in l[:2] and c[1] not in l[:2] for l in layer):
                    layer.append(c)
                    break
            else:
                layers.append([c])
        pairs = [c for layer in layers for c in layer]
    return pairs


def circuit_cost_diagonal(ising: Ising, spec: CircuitSpec) -> np.ndarray:
    """Normalised cost actually implemented by the (possibly pruned) circuit."""
    z = _z_values()
    s = ising.scale()
    cost = z @ (ising.h / s)
    for i, j, v in kept_couplings(ising, spec):
        cost = cost + (v / s) * z[:, i] * z[:, j]
    return cost


def _warm_thetas(spec: CircuitSpec) -> np.ndarray | None:
    if not spec.warm_start:
        return None
    bits = nm.bitstring_to_bits(spec.warm_start).astype(float)
    c = np.clip(bits, spec.warm_epsilon, 1 - spec.warm_epsilon)
    return 2 * np.arcsin(np.sqrt(c))


def _apply_rx_all(psi: np.ndarray, beta: float) -> np.ndarray:
    c, s = np.cos(beta), -1j * np.sin(beta)
    t = psi.reshape([2] * nm.N_BITS)
    for q in range(nm.N_BITS):
        ax = nm.N_BITS - 1 - q            # state index bit q ↔ axis N-1-q in C order
        a = np.take(t, 0, axis=ax)
        b = np.take(t, 1, axis=ax)
        t = np.stack([c * a + s * b, s * a + c * b], axis=ax)
    return t.reshape(-1)


def _apply_warm_mixer(psi: np.ndarray, beta: float, thetas: np.ndarray) -> np.ndarray:
    """RY(θ) RZ(2β) RY(-θ) per qubit (warm-start mixer)."""
    t = psi.reshape([2] * nm.N_BITS)
    for q in range(nm.N_BITS):
        th = thetas[q]
        ry = lambda a: np.array([[np.cos(a / 2), -np.sin(a / 2)], [np.sin(a / 2), np.cos(a / 2)]])
        rz = np.diag([np.exp(-1j * beta), np.exp(1j * beta)])
        u = ry(th) @ rz @ ry(-th)
        ax = nm.N_BITS - 1 - q
        t = np.moveaxis(np.tensordot(u, np.moveaxis(t, ax, 0), axes=(1, 0)), 0, ax)
    return t.reshape(-1)


def _initial_state(spec: CircuitSpec) -> np.ndarray:
    thetas = _warm_thetas(spec)
    if thetas is None:
        return np.full(nm.N_STATES, 1 / np.sqrt(nm.N_STATES), dtype=complex)
    amp1, amp0 = np.sin(thetas / 2), np.cos(thetas / 2)
    bits = nm.all_bits()
    return np.prod(np.where(bits == 1, amp1, amp0), axis=1).astype(complex)


def qaoa_probabilities(cost: np.ndarray, gammas, betas, spec: CircuitSpec) -> np.ndarray:
    psi = _initial_state(spec)
    thetas = _warm_thetas(spec)
    for g, b in zip(gammas, betas):
        psi = psi * np.exp(-1j * g * cost)
        psi = _apply_warm_mixer(psi, b, thetas) if thetas is not None else _apply_rx_all(psi, b)
    return np.abs(psi) ** 2


def optimise_angles(ising: Ising, spec: CircuitSpec, objective: np.ndarray | None = None, restarts: int = 12, seed: int = 5):
    """Minimise the expected cost over (γ, β) on an exact statevector (cheap at 8 qubits).

    `objective` defaults to the implemented circuit cost; passing the full (unpruned) energy
    lets angles compensate for pruning.
    """
    from scipy.optimize import minimize

    cost = circuit_cost_diagonal(ising, spec)
    target = cost if objective is None else (objective - objective.mean()) / (np.abs(objective).max() + 1e-12)
    rng = np.random.default_rng(seed)
    p = spec.reps

    def f(x):
        return float(qaoa_probabilities(cost, x[:p], x[p:], spec) @ target)

    best = None
    for r in range(restarts):
        x0 = np.concatenate([rng.uniform(0, np.pi, p), rng.uniform(0, np.pi / 2, p)]) if r else \
            np.concatenate([np.linspace(0.2, 0.8, p), np.linspace(0.6, 0.2, p)])
        res = minimize(f, x0, method="COBYLA", options={"maxiter": 400, "rhobeg": 0.3})
        if best is None or res.fun < best.fun:
            best = res
    return best.x[:p].tolist(), best.x[p:].tolist(), float(best.fun)


# ---------------------------------------------------------------- qiskit circuits

def build_qaoa(ising: Ising, spec: CircuitSpec):
    from qiskit import QuantumCircuit

    if spec.gammas is None or spec.betas is None:
        raise ValueError("angles missing: call optimise_angles first")
    s = ising.scale()
    thetas = _warm_thetas(spec)
    couplings = kept_couplings(ising, spec)
    qc = QuantumCircuit(nm.N_BITS, name="cortex2_qaoa")
    if thetas is None:
        qc.h(range(nm.N_BITS))
    else:
        for q in range(nm.N_BITS):
            qc.ry(float(thetas[q]), q)
    for g, b in zip(spec.gammas, spec.betas):
        # exp(-i γ C), C = Σ h_i Z_i + Σ J_ij Z_i Z_j ; RZ(θ)=exp(-iθZ/2) → θ = 2γh
        for q in range(nm.N_BITS):
            if abs(ising.h[q]) > 1e-12:
                qc.rz(float(2 * g * ising.h[q] / s), q)
        for i, j, v in couplings:
            qc.rzz(float(2 * g * v / s), i, j)
        for q in range(nm.N_BITS):
            if thetas is None:
                qc.rx(float(2 * b), q)
            else:
                qc.ry(float(-thetas[q]), q)
                qc.rz(float(2 * b), q)
                qc.ry(float(thetas[q]), q)
    qc.measure_all()
    return qc


def parse_qasm(text: str):
    """Parse agent-authored OpenQASM 2.0. Data only: no Python is executed."""
    from qiskit import qasm2

    if len(text) > MAX_QASM_CHARS:
        raise ValueError("qasm too long")
    qc = qasm2.loads(text, custom_instructions=qasm2.LEGACY_CUSTOM_INSTRUCTIONS)
    if qc.num_qubits != nm.N_BITS:
        raise ValueError(f"circuit must use exactly {nm.N_BITS} qubits, got {qc.num_qubits}")
    if qc.size() > MAX_LOGICAL_OPS:
        raise ValueError("circuit too large")
    names = {inst.operation.name for inst in qc.data}
    if "measure" not in names:
        qc.measure_all()
    elif qc.num_clbits < nm.N_BITS:
        raise ValueError("measure all 8 qubits")
    measured = {qc.find_bit(inst.qubits[0]).index for inst in qc.data if inst.operation.name == "measure"}
    if len(measured) != nm.N_BITS:
        raise ValueError("every qubit must be measured exactly once at the end")
    return qc


def to_qasm(qc) -> str:
    from qiskit import qasm2

    return qasm2.dumps(qc)


@lru_cache(maxsize=4)
def offline_backend(name: str = OFFLINE_TARGET):
    from qiskit_ibm_runtime import fake_provider

    cls = {"fake_torino": "FakeTorino", "fake_sherbrooke": "FakeSherbrooke", "fake_brisbane": "FakeBrisbane",
           "fake_kyiv": "FakeKyiv", "fake_fez": "FakeFez"}.get(name, "FakeTorino")
    return getattr(fake_provider, cls)()


def _two_qubit_stats(qc) -> tuple[int, int]:
    twoq = sum(1 for inst in qc.data if inst.operation.num_qubits == 2 and inst.operation.name != "barrier")
    depth2 = qc.depth(lambda inst: inst.operation.num_qubits == 2 and inst.operation.name != "barrier")
    return twoq, depth2


def gate_stats(qc) -> dict:
    ops = dict(qc.count_ops())
    non_gate = {"measure", "barrier"}
    twoq, depth2 = _two_qubit_stats(qc)
    return {"size": qc.size(), "gates": int(sum(v for k, v in ops.items() if k not in non_gate)),
            "depth": qc.depth(), "two_qubit_gates": twoq, "two_qubit_depth": depth2, "ops": {k: int(v) for k, v in ops.items()}}


def transpile(qc, backend=None, optimization_level: int = 3, seed: int = 11):
    from qiskit.transpiler import generate_preset_pass_manager

    backend = backend or offline_backend()
    pm = generate_preset_pass_manager(backend=backend, optimization_level=optimization_level, seed_transpiler=seed)
    isa = pm.run(qc)
    layout = isa.layout.final_index_layout() if isa.layout is not None else list(range(nm.N_BITS))
    stats = gate_stats(isa)
    return isa, {**stats, "backend": getattr(backend, "name", str(backend)), "physical_qubits": layout[: nm.N_BITS],
                 "within_budget": stats["gates"] <= GATE_BUDGET, "budget": GATE_BUDGET}


def describe(qc, cap: int = 600) -> dict:
    """Serializable operation list for the browser circuit viewer."""
    ops = []
    for inst in qc.data[:cap]:
        op = inst.operation
        if op.name == "barrier":
            continue
        ops.append({"gate": op.name, "qubits": [qc.find_bit(q).index for q in inst.qubits],
                    "params": [round(float(p), 4) for p in op.params if isinstance(p, (int, float, np.floating))]})
    return {"qubits": qc.num_qubits, "operations": ops, "truncated": len(qc.data) > cap, **gate_stats(qc)}


def ideal_distribution(qc) -> dict[str, float]:
    from qiskit.quantum_info import Statevector

    bare = qc.remove_final_measurements(inplace=False)
    probs = Statevector(bare).probabilities_dict()
    return {k[-nm.N_BITS:]: float(v) for k, v in probs.items() if v > 1e-9}


def _counts_from_sampler_result(pub_result) -> dict[str, int]:
    data = pub_result.data
    reg = getattr(data, "meas", None) or next(iter(data.values()))
    return {k: int(v) for k, v in reg.get_counts().items()}


def run_simulator(qc, shots: int = DEFAULT_SHOTS, noisy: bool = False, seed: int = 19) -> tuple[dict[str, int], dict]:
    """Aer execution. noisy=True uses the offline IBM device noise model and its transpiled circuit."""
    from qiskit_aer import AerSimulator
    from qiskit_aer.primitives import SamplerV2

    if noisy:
        backend = offline_backend()
        sim = AerSimulator.from_backend(backend, seed_simulator=seed)
        isa, stats = transpile(qc, backend)
        sampler = SamplerV2(options={"backend_options": {"noise_model": sim.options.noise_model}, "run_options": {"seed": seed}})
        result = sampler.run([isa], shots=shots).result()[0]
        return _counts_from_sampler_result(result), {"mode": "aer_noisy", "noise_model": backend.name, **stats}
    sampler = SamplerV2(options={"run_options": {"seed": seed}})
    result = sampler.run([qc], shots=shots).result()[0]
    return _counts_from_sampler_result(result), {"mode": "aer_ideal"}


def total_variation(p: dict[str, float], q: dict[str, float]) -> float:
    keys = set(p) | set(q)
    return 0.5 * float(sum(abs(p.get(k, 0.0) - q.get(k, 0.0)) for k in keys))


def normalise(counts: dict[str, int]) -> dict[str, float]:
    n = sum(counts.values()) or 1
    return {k: v / n for k, v in counts.items()}


# ---------------------------------------------------------------- IBM Quantum Runtime

def ibm_configured() -> bool:
    return bool(os.environ.get("IBM_QUANTUM_TOKEN"))


_SERVICE = None
_SERVICE_KEY = None
_QUOTA: dict = {"checked": 0.0, "state": None, "refreshing": False}
QUOTA_TTL = 600


def _service():
    """Cached QiskitRuntimeService (constructing one costs several seconds of network round-trips)."""
    global _SERVICE, _SERVICE_KEY
    from qiskit_ibm_runtime import QiskitRuntimeService

    token = os.environ.get("IBM_QUANTUM_TOKEN")
    if not token:
        raise RuntimeError("IBM_QUANTUM_TOKEN is not configured")
    key = (token, os.environ.get("IBM_QUANTUM_INSTANCE"))
    if _SERVICE is None or _SERVICE_KEY != key:
        kwargs = {"channel": "ibm_quantum_platform", "token": token}
        if key[1]:
            kwargs["instance"] = key[1]
        _SERVICE, _SERVICE_KEY = QiskitRuntimeService(**kwargs), key
    return _SERVICE


def _refresh_quota() -> None:
    try:
        u = _service().usage()
        _QUOTA["state"] = {"limit_reached": bool(u.get("usage_limit_reached")),
                           "remaining_seconds": u.get("usage_remaining_seconds"),
                           "limit_seconds": u.get("usage_limit_seconds"),
                           "available_at": u.get("time_available_at")}
    except Exception as exc:
        _QUOTA["state"] = {"error": str(exc)[:200]}
    finally:
        _QUOTA["checked"] = time.time()
        _QUOTA["refreshing"] = False


def ibm_quota(block: bool = False) -> dict | None:
    """Open-plan usage, refreshed in the background so request paths never wait on IBM."""
    import threading

    stale = time.time() - _QUOTA["checked"] > QUOTA_TTL
    if stale and ibm_configured():
        if block:
            _refresh_quota()
        elif not _QUOTA["refreshing"]:
            _QUOTA["refreshing"] = True
            threading.Thread(target=_refresh_quota, daemon=True).start()
    return _QUOTA["state"]


def ibm_availability() -> tuple[bool, str | None]:
    if not ibm_configured():
        return False, "IBM_QUANTUM_TOKEN is not configured on the server"
    q = ibm_quota() or {}
    if q.get("limit_reached"):
        return False, (f"IBM Open-plan QPU time exhausted ({q.get('limit_seconds')} s / 28 days); "
                       f"jobs would queue until {q.get('available_at') or 'the next reset'}")
    return True, None


def ibm_backend():
    service = _service()
    name = os.environ.get("IBM_BACKEND")
    return service.backend(name) if name else service.least_busy(operational=True, simulator=False, min_num_qubits=nm.N_BITS)


def ibm_backends() -> list[dict]:
    service = _service()
    out = []
    for b in service.backends(simulator=False, operational=True):
        try:
            pending = b.status().pending_jobs
        except Exception:
            pending = None
        out.append({"name": b.name, "qubits": b.num_qubits, "pending_jobs": pending})
    return out


def submit_ibm(qc, shots: int = DEFAULT_SHOTS, optimization_level: int = 3, seed: int = 11) -> dict:
    from qiskit_ibm_runtime import SamplerV2

    quota = ibm_quota(block=True) or {}
    if quota.get("limit_reached"):
        raise RuntimeError(f"IBM Open-plan QPU time is exhausted; a job would stay queued until "
                           f"{quota.get('available_at') or 'the next reset'}. Not submitting.")
    backend = ibm_backend()
    isa, stats = transpile(qc, backend, optimization_level, seed)
    job = SamplerV2(mode=backend).run([isa], shots=shots)
    return {"provider_job_id": job.job_id(), "backend": backend.name, "transpiled": stats,
            "isa_circuit": describe(isa), "isa_qasm": None}


def poll_ibm(provider_job_id: str) -> dict:
    job = _service().job(provider_job_id)
    status = job.status()
    status = getattr(status, "name", str(status)).upper()
    if status in ("DONE",):
        result = job.result()
        metrics = {}
        try:
            metrics = job.metrics()
        except Exception:
            pass
        usage = metrics.get("usage", {}) if isinstance(metrics, dict) else {}
        return {"status": "done", "counts": _counts_from_sampler_result(result[0]),
                "quantum_seconds": usage.get("quantum_seconds"), "timestamps": metrics.get("timestamps") if isinstance(metrics, dict) else None}
    if status in ("ERROR", "CANCELLED"):
        msg = ""
        try:
            msg = job.error_message() or ""
        except Exception:
            pass
        return {"status": "failed", "error": f"IBM job {status.lower()} {msg}".strip()}
    return {"status": "pending", "provider_status": status.lower()}

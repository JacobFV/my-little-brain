"""Execution backends: one self-describing adapter per compute target, behind a registry.

Every backend samples bitstrings for the same inverse problem, through one of three paradigms:

    gate       runs a Qiskit circuit (QAOA from a spec, or agent-written OpenQASM)
    ising      samples the Ising/QUBO energy directly (thermodynamic, annealing, …)
    classical  solves from the target itself (enumeration, random baselines)

and one of two modes: `sync` (returns counts within the worker request) or `async`
(submit → provider job id → polled by delayed tasks). To add a new quantum service, subclass
the matching base class, describe its capabilities (they are shown to the agent and the UI),
and call `register(...)`. Nothing else in the runner, agent or UI needs to change.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, ClassVar

from . import classical, ionq, quantum as qm


@dataclass
class Capabilities:
    paradigm: str                    # gate | ising | classical
    mode: str = "sync"               # sync | async
    hardware: bool = False           # physical device (explicit user action / autonomous opt-in)
    connectivity: str = ""           # e.g. "all-to-all", "heavy-hex (SWAP routing)"
    noise: str = ""                  # e.g. "none", "IBM device noise model"
    cost: str = "free"               # human-readable cost / quota note
    vendor: str = ""
    notes: str = ""
    options: dict = field(default_factory=dict)   # provider-specific spec keys → description

    def to_json(self) -> dict:
        return {k: v for k, v in self.__dict__.items()}


class Backend:
    id: ClassVar[str]
    label: ClassVar[str]
    kind: ClassVar[str]              # classical | quantum_simulator | quantum_hardware | thermodynamic_simulator
    caps: ClassVar[Capabilities]

    def availability(self) -> tuple[bool, str | None]:
        return True, None

    def describe(self) -> dict:
        ok, reason = self.availability()
        return {"id": self.id, "label": self.label, "kind": self.kind, "available": ok, "reason": reason,
                "capabilities": self.caps.to_json()}

    # async backends
    def poll(self, provider_job_id: str, shots: int) -> dict:
        raise NotImplementedError

    def cancel(self, provider_job_id: str) -> None:
        pass


class GateBackend(Backend):
    """run(qc) for sync; submit(qc)/poll/cancel for async. Both return transpiled stats + ISA circuit."""

    def compile(self, qc, options: dict) -> tuple[Any, dict]:
        return qm.transpile(qc, optimization_level=int(options.get("optimization_level", 3)))

    def run(self, qc, shots: int, options: dict) -> tuple[dict[str, int], dict, dict, Any]:
        raise NotImplementedError

    def submit(self, qc, shots: int, options: dict, name: str) -> dict:
        raise NotImplementedError


class IsingBackend(Backend):
    def sample(self, ising, qubo, shots: int, options: dict) -> tuple[dict[str, int], dict, dict[str, float] | None]:
        """Returns (counts, runner meta, reference distribution the sampler should match, or None)."""
        raise NotImplementedError


class ClassicalBackend(Backend):
    def solve(self, target, qubo, shots: int, options: dict) -> tuple[dict[str, int], dict]:
        raise NotImplementedError


# ---------------------------------------------------------------- classical

class Exact(ClassicalBackend):
    id, label, kind = "classical_exact", "Exact enumeration (classical)", "classical"
    caps = Capabilities("classical", notes="re-simulates all 256 hypotheses; the ground-truth reference")

    def solve(self, target, qubo, shots, options):
        return classical.exact_counts(target)


class RandomBaseline(ClassicalBackend):
    id, label, kind = "random", "Uniform random baseline", "classical"
    caps = Capabilities("classical", notes="null model every sampler must beat")

    def solve(self, target, qubo, shots, options):
        return classical.random_counts(shots, int(options.get("seed", 0)))


class Anneal(IsingBackend):
    id, label, kind = "classical_anneal", "Simulated annealing (classical)", "classical"
    caps = Capabilities("ising", notes="Metropolis annealing on the same QUBO the quantum backends see",
                        options={"sweeps": "annealing sweeps (default 60)"})

    def sample(self, ising, qubo, shots, options):
        counts, meta = classical.anneal_counts(qubo, shots, sweeps=int(options.get("sweeps", 60)), seed=int(options.get("seed", 0)))
        return counts, meta, None


# ---------------------------------------------------------------- thermodynamic

class Thrml(IsingBackend):
    id, label, kind = "thrml", "Extropic THRML · thermodynamic Gibbs sampler (software)", "thermodynamic_simulator"
    caps = Capabilities("ising", connectivity="dense Ising (all pairs)", vendor="Extropic",
                        notes="Extropic's open-source THRML block-Gibbs sampler on CPU; not physical TSU hardware",
                        options={"beta": "inverse temperature (default 3.0)"})

    def availability(self):
        try:
            import thrml  # noqa: F401
        except ImportError:
            return False, "thrml/jax not installed in this image"
        return True, None

    def sample(self, ising, qubo, shots, options):
        from . import thermo

        beta = float(options.get("beta", 3.0))
        counts, meta = thermo.sample(ising, shots, beta=beta)
        return counts, meta, thermo.boltzmann_reference(ising, beta)


# ---------------------------------------------------------------- IBM (Qiskit)

class AerIdeal(GateBackend):
    id, label, kind = "aer_ideal", "Qiskit Aer · ideal statevector sampler", "quantum_simulator"
    caps = Capabilities("gate", connectivity="compiled for IBM heavy-hex (SWAP routing)", noise="none", vendor="IBM/Qiskit")

    def run(self, qc, shots, options):
        isa, stats = self.compile(qc, options)
        counts, meta = qm.run_simulator(qc, shots, noisy=False)
        return counts, meta, stats, isa


class AerNoisy(GateBackend):
    id, label, kind = "aer_noisy", "Qiskit Aer · IBM device noise model", "quantum_simulator"
    caps = Capabilities("gate", connectivity="IBM heavy-hex (SWAP routing)", noise=f"{qm.OFFLINE_TARGET} calibration noise model",
                        vendor="IBM/Qiskit", notes="closest free proxy for IBM hardware")

    def run(self, qc, shots, options):
        counts, meta = qm.run_simulator(qc, shots, noisy=True)
        isa, stats = self.compile(qc, options)
        return counts, meta, stats, isa


class IBMRuntime(GateBackend):
    id, label, kind = "ibm_quantum", "IBM Quantum · physical QPU", "quantum_hardware"
    caps = Capabilities("gate", mode="async", hardware=True, connectivity="heavy-hex (SWAP routing)", noise="physical device",
                        vendor="IBM", cost="Open plan ≈10 QPU-minutes / 28 days")

    def availability(self):
        return qm.ibm_availability()

    def submit(self, qc, shots, options, name):
        sub = qm.submit_ibm(qc, shots, int(options.get("optimization_level", 3)))
        return {"provider_job_id": sub["provider_job_id"], "backend": sub["backend"], "transpiled": sub["transpiled"],
                "isa_circuit": sub["isa_circuit"]}

    def poll(self, provider_job_id, shots):
        return qm.poll_ibm(provider_job_id)

    def cancel(self, provider_job_id):
        qm._service().job(provider_job_id).cancel()


# ---------------------------------------------------------------- IonQ (REST)

class _IonQ(GateBackend):
    def availability(self):
        return (True, None) if ionq.configured() else (False, "IONQ_API_KEY is not configured on the server")

    def compile(self, qc, options):
        return ionq.to_qis(qc)[0::2]


class IonQSimulator(_IonQ):
    id, label, kind = "ionq_simulator", "IonQ cloud simulator · trapped-ion noise model", "quantum_simulator"
    caps = Capabilities("gate", connectivity="all-to-all (no SWAPs)", noise="IonQ device noise model (default forte-1)",
                        vendor="IonQ", cost="free simulator",
                        options={"ionq_noise": " | ".join(ionq.NOISE_MODELS)})

    def run(self, qc, shots, options):
        noise = options.get("ionq_noise") if options.get("ionq_noise") in ionq.NOISE_MODELS else ionq.noise_model()
        counts, meta = ionq.run_blocking(qc, shots, noise)
        isa, stats = self.compile(qc, options)
        return counts, meta, stats, isa


class IonQQPU(_IonQ):
    id, label, kind = "ionq_qpu", "IonQ · physical trapped-ion QPU", "quantum_hardware"
    caps = Capabilities("gate", mode="async", hardware=True, connectivity="all-to-all (no SWAPs)", noise="physical device",
                        vendor="IonQ", cost="billed per gate/shot to the IonQ account (estimate attached to each job)")

    def availability(self):
        return ionq.qpu_access()

    def submit(self, qc, shots, options, name):
        backend = ionq.qpu_backend()
        cost = None
        try:
            cost = ionq.estimate(qc, shots, backend)
        except Exception as exc:  # estimates are informative; never block a submission the user confirmed
            cost = {"error": str(exc)[:200]}
        ionq.submit(qc, shots, backend, name=name, dry_run=True)       # server-side validation, no charge
        sub = ionq.submit(qc, shots, backend, name=name)
        sub["isa_circuit"] = qm.describe(ionq.to_qis(qc)[0])
        sub["transpiled"]["cost_estimate"] = cost      # persisted with the job's transpiled stats
        return sub

    def poll(self, provider_job_id, shots):
        return ionq.poll(provider_job_id, shots)

    def cancel(self, provider_job_id):
        ionq.cancel(provider_job_id)


# ---------------------------------------------------------------- registry

REGISTRY: dict[str, Backend] = {}


def register(backend: Backend) -> Backend:
    REGISTRY[backend.id] = backend
    return backend


for _b in (Exact(), RandomBaseline(), Anneal(), Thrml(), AerIdeal(), AerNoisy(), IBMRuntime(), IonQSimulator(), IonQQPU()):
    register(_b)


def get(backend_id: str) -> Backend:
    if backend_id not in REGISTRY:
        raise ValueError(f"unknown provider {backend_id!r}; known: {sorted(REGISTRY)}")
    return REGISTRY[backend_id]


def ids(*, paradigm: str | None = None, mode: str | None = None, hardware: bool | None = None) -> list[str]:
    return [b.id for b in REGISTRY.values()
            if (paradigm is None or b.caps.paradigm == paradigm) and (mode is None or b.caps.mode == mode)
            and (hardware is None or b.caps.hardware == hardware)]


def catalog() -> list[dict]:
    return [b.describe() for b in REGISTRY.values()]


def agent_brief() -> str:
    """Capability summary injected into the agent's instructions."""
    lines = []
    for b in REGISTRY.values():
        ok, reason = b.availability()
        c = b.caps
        bits = [c.paradigm, c.mode, "HARDWARE" if c.hardware else "", c.connectivity, c.noise and f"noise: {c.noise}",
                c.cost if c.cost != "free" else "", c.notes, c.options and f"options: {c.options}"]
        lines.append(f"- {b.id}: {b.label} — " + "; ".join(x for x in bits if x) + ("" if ok else f" [UNAVAILABLE: {reason}]"))
    return "\n".join(lines)

"""Private Cloud Run service: sample an Ising energy with Extropic's THRML (block Gibbs on JAX, CPU).

Same convention as cortex2.inverse.Ising / cortex2.thermo:
    E(z) = offset + Σ h_i z_i + Σ_{i<j} J_ij z_i z_j,   bit b = (1 - z) / 2,  bitstring = bits reversed (qubit 0 rightmost).
J may be dense ([[...]] n×n, upper triangle used) or sparse ([[i, j, J_ij], ...]).
"""
from __future__ import annotations

import os
import platform
import time

import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

app = FastAPI(title="thrml-sampler")
_JIT_CACHE: dict = {}


class SampleRequest(BaseModel):
    h: list[float] = Field(..., min_length=1, max_length=64)
    J: list[list[float]] = Field(default_factory=list)
    offset: float = 0.0
    shots: int = Field(1024, ge=1, le=1_000_000)
    beta: float = Field(3.0, gt=0, le=1e3)
    seed: int | None = None
    chains: int = Field(16, ge=1, le=4096)
    warmup: int = Field(200, ge=0, le=100_000)
    steps_per_sample: int = Field(4, ge=1, le=1000)


def _dense_j(n: int, J: list[list[float]]) -> np.ndarray:
    out = np.zeros((n, n))
    if not J:
        return out
    if len(J) == n and all(len(r) == n for r in J):
        return np.triu(np.asarray(J, dtype=float), 1)
    for row in J:
        if len(row) != 3:
            raise ValueError("J must be dense n×n or sparse [[i, j, value], ...]")
        i, j, v = int(row[0]), int(row[1]), float(row[2])
        if not (0 <= i < n and 0 <= j < n) or i == j:
            raise ValueError(f"bad coupling index ({i}, {j})")
        out[min(i, j), max(i, j)] += v
    return out


def _bitstring(bits) -> str:
    return "".join(str(int(b)) for b in np.asarray(bits)[::-1])


def sample(h: np.ndarray, J: np.ndarray, shots: int, beta: float, seed: int, chains: int, warmup: int, steps: int):
    import jax
    import jax.numpy as jnp
    from thrml import Block, SamplingSchedule, SpinNode, sample_states
    from thrml.models import IsingEBM, IsingSamplingProgram, hinton_init

    n = len(h)
    s = float(max(np.abs(h).max(), np.abs(J).max(), 1e-12))
    nodes = [SpinNode() for _ in range(n)]
    pairs = [(i, j) for i in range(n) for j in range(i + 1, n)]
    edges = [(nodes[i], nodes[j]) for i, j in pairs]
    # thrml: E(s) = -beta (b·s + Σ W_ij s_i s_j), s=+1 ↔ True. Ours: E(z) = h·z + Σ J z z, z=+1 ↔ bit 0.
    biases = jnp.asarray(-h / s, dtype=jnp.float32)
    weights = jnp.asarray([-J[i, j] / s for i, j in pairs], dtype=jnp.float32)
    model = IsingEBM(nodes, edges, biases, weights, jnp.asarray(beta, dtype=jnp.float32))
    blocks = [Block([nd]) for nd in nodes]          # dense couplings → single-spin blocks
    program = IsingSamplingProgram(model, blocks, clamped_blocks=[])
    per_chain = int(np.ceil(shots / chains))
    schedule = SamplingSchedule(n_warmup=warmup, n_samples=per_chain, steps_per_sample=steps)

    def one_chain(key):
        k1, k2 = jax.random.split(key)
        init = hinton_init(k1, model, blocks, ())
        return sample_states(k2, program, schedule, init, [], [Block(nodes)])[0]

    start = time.monotonic()
    keys = jax.random.split(jax.random.key(seed), chains)
    raw = np.asarray(jax.jit(jax.vmap(one_chain))(keys)).reshape(-1, n)[:shots]
    elapsed = time.monotonic() - start
    counts: dict[str, int] = {}
    for spins in raw:
        key = _bitstring(1 - spins.astype(int))   # True (+1) → bit 0
        counts[key] = counts.get(key, 0) + 1
    return counts, elapsed


@app.get("/health")
def health():
    import jax
    import thrml  # noqa: F401
    from importlib.metadata import version
    return {"ok": True, "backend": "thrml-jax-cpu", "thrml": version("thrml"), "jax": jax.__version__,
            "devices": [str(d) for d in jax.devices()], "cpus": os.cpu_count()}


@app.post("/sample")
def post_sample(req: SampleRequest):
    import jax
    t0 = time.monotonic()
    h = np.asarray(req.h, dtype=float)
    try:
        J = _dense_j(len(h), req.J)
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    seed = req.seed if req.seed is not None else int.from_bytes(os.urandom(4), "little")
    counts, sample_s = sample(h, J, req.shots, req.beta, seed, req.chains, req.warmup, req.steps_per_sample)
    return {"counts": counts, "meta": {
        "mode": "thrml_block_gibbs", "backend": "thrml-jax-cpu", "device": str(jax.devices()[0]),
        "platform": platform.machine(), "n_spins": len(h), "n_chains": req.chains, "shots": req.shots,
        "beta": req.beta, "seed": seed, "warmup": req.warmup, "steps_per_sample": req.steps_per_sample,
        "offset": req.offset, "sample_seconds": round(sample_s, 3),
        "elapsed_seconds": round(time.monotonic() - t0, 3), "library": "thrml",
        "hardware": "cpu (software simulation of thermodynamic sampling)"}}

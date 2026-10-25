"""Thermodynamic sampling of the shared Ising model with Extropic's THRML (block Gibbs, JAX).

This runs Extropic's open-source THRML library — the software stack for programs targeting
their thermodynamic sampling units (TSUs) — on our CPU worker. It samples the *same* Ising
energy as the QAOA path, at inverse temperature beta. It is not a quantum circuit, and no
physical Extropic hardware is used unless Extropic grants device access (none is assumed).
"""
from __future__ import annotations

import time

import numpy as np

from . import neural as nm
from .inverse import Ising


def sample(ising: Ising, shots: int = 1024, beta: float = 3.0, chains: int = 16, warmup: int = 200,
           steps_per_sample: int = 4, seed: int = 42) -> tuple[dict[str, int], dict]:
    import jax
    import jax.numpy as jnp
    from thrml import Block, SamplingSchedule, SpinNode, sample_states
    from thrml.models import IsingEBM, IsingSamplingProgram, hinton_init

    s = ising.scale()
    nodes = [SpinNode() for _ in range(nm.N_BITS)]
    pairs = [(i, j) for i in range(nm.N_BITS) for j in range(i + 1, nm.N_BITS)]
    edges = [(nodes[i], nodes[j]) for i, j in pairs]
    # thrml: E(s) = -beta (b·s + Σ W_ij s_i s_j), s=+1 ↔ True. Ours: E(z) = h·z + Σ J z z, z=+1 ↔ bit 0.
    biases = jnp.asarray(-ising.h / s, dtype=jnp.float32)
    weights = jnp.asarray([-ising.J[i, j] / s for i, j in pairs], dtype=jnp.float32)
    model = IsingEBM(nodes, edges, biases, weights, jnp.asarray(beta, dtype=jnp.float32))
    blocks = [Block([n]) for n in nodes]          # dense couplings → no parallel 2-colouring
    program = IsingSamplingProgram(model, blocks, clamped_blocks=[])
    per_chain = int(np.ceil(shots / chains))
    schedule = SamplingSchedule(n_warmup=warmup, n_samples=per_chain, steps_per_sample=steps_per_sample)

    def one_chain(key):
        k1, k2 = jax.random.split(key)
        init = hinton_init(k1, model, blocks, ())
        return sample_states(k2, program, schedule, init, [], [Block(nodes)])[0]

    start = time.monotonic()
    keys = jax.random.split(jax.random.key(seed), chains)
    raw = np.asarray(jax.jit(jax.vmap(one_chain))(keys)).reshape(-1, nm.N_BITS)[:shots]
    elapsed = time.monotonic() - start
    counts: dict[str, int] = {}
    for spins in raw:
        bits = 1 - spins.astype(int)               # True (+1) → bit 0
        key = nm.bits_to_bitstring(bits)
        counts[key] = counts.get(key, 0) + 1
    return counts, {"mode": "thrml_block_gibbs", "beta": beta, "chains": chains, "warmup": warmup,
                    "steps_per_sample": steps_per_sample, "seed": seed, "elapsed_seconds": round(elapsed, 3),
                    "library": "thrml", "hardware": "cpu (software simulation of thermodynamic sampling)"}


def boltzmann_reference(ising: Ising, beta: float) -> dict[str, float]:
    """Exact Boltzmann distribution the sampler should converge to (8 spins → enumerable)."""
    z = 1 - 2 * nm.all_bits()
    s = ising.scale()
    e = (z @ ising.h + sum(ising.J[i, j] * z[:, i] * z[:, j] for i in range(nm.N_BITS) for j in range(i + 1, nm.N_BITS))) / s
    w = np.exp(-beta * (e - e.min()))
    w /= w.sum()
    return {nm.bits_to_bitstring(b): float(p) for b, p in zip(nm.all_bits(), w)}

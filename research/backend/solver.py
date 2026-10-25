"""Cortex²: reproducible 8-bit neural inverse-model benchmark and compute adapters.

The 8-dimensional feature vector is an explicitly synthetic forward model, not EEG
source localization. Physical IBM hardware runs QAOA circuits; Extropic THRML is
a JAX software sampler, *not* a quantum-circuit surrogate or physical TSU.
"""
from __future__ import annotations
from collections import Counter
from dataclasses import dataclass
from itertools import product
import math
import time
import numpy as np

N_BITS = 8
N_FEATURES = 8
PARAM_NAMES = ("excitatory_drive", "inhibitory_gain", "recurrent_excitation", "synaptic_timescale")
TRUE_BITS = (1, 0, 0, 1, 1, 1, 0, 1)


def unpack(bits):
    b = np.asarray(bits, dtype=float)
    return np.asarray([(b[2*i] + 2*b[2*i+1])/3 for i in range(4)])


def forward(bits):
    """Deterministic synthetic spectral-feature surrogate of four neural parameters."""
    e, inh, rec, tau = unpack(bits)
    return np.array([
        0.3 + 1.25 * e - 0.32 * inh + 0.1 * rec**2,
        0.6 - 0.8 * inh + 0.23 * e * rec,
        0.2 + .7 * rec + .17 * np.sin(2*e),
        0.4 + .65 * tau + .1 * rec * tau,
        .1 + e*inh + .3*tau,
        .2 + .5*rec*inh + .23*e*tau,
        .5 + .27*e**2 - .16*inh**2 + .2*tau,
        .7 - .32*rec + .45*np.sin(tau * 1.2 + e*.2),
    ], dtype=float)


def make_problem():
    zero = np.zeros(N_BITS, dtype=int)
    origin = forward(zero)
    target = forward(TRUE_BITS)
    # Secant response to each encoded binary bit gives a reproducible local
    # quadratic approximation of the real nonlinear model objective.
    matrix = np.stack([forward(np.eye(N_BITS, dtype=int)[i]) - origin for i in range(N_BITS)],axis=1)
    residual = target - origin
    Q = matrix.T @ matrix
    linear = -2 * (matrix.T @ residual)
    return {"q": Q, "linear": linear, "constant": float(residual @ residual),
            "matrix": matrix, "target": target, "origin": origin}


def energy(bits, problem):
    b = np.asarray(bits, dtype=float)
    return float(b @ problem["q"] @ b + problem["linear"] @ b + problem["constant"])


def actual_loss(bits, problem):
    return float(np.sum((forward(bits) - problem["target"])**2))


def summarize(states, problem, provider, gate_count=None, provider_job_id=None):
    counts = Counter(states)
    if not counts:
        raise ValueError("no provider samples returned")
    candidates = []
    for state, count in counts.items():
        bits = np.array([int(c) for c in state[::-1]], dtype=int)
        candidates.append({"bitstring":state, "samples":count,
                           "qubo_objective":energy(bits, problem),
                           "nonlinear_loss":actual_loss(bits, problem),
                           "parameters":dict(zip(PARAM_NAMES, unpack(bits).tolist()))})
    candidates.sort(key=lambda x:x["nonlinear_loss"])
    return {"provider":provider, "counts":dict(counts), "candidates":candidates[:15],
            "objective":candidates[0]["nonlinear_loss"], "ground_truth_bits":"".join(map(str,TRUE_BITS[::-1])),
            "gate_count":gate_count,"provider_job_id":provider_job_id,
            "scientific_scope":"synthetic benchmark, not epilepsy diagnosis"}


def exact(problem):
    start = time.monotonic()
    states = ["".join(map(str,bits[::-1])) for bits in product((0,1), repeat=N_BITS)]
    ranked = sorted(states, key=lambda state: actual_loss([int(c) for c in state[::-1]],problem))
    result = summarize(ranked[:32], problem,"classical")
    result["all_states_searched"]=len(states)
    result["elapsed_seconds"]=round(time.monotonic()-start,6)
    return result


def circuit(problem, gamma=0.65, beta=0.43):
    from qiskit import QuantumCircuit
    qc = QuantumCircuit(N_BITS)
    qc.h(range(N_BITS))
    Q, l = problem["q"],problem["linear"]
    for i in range(N_BITS):
        field = -.5 * (l[i] + Q[i,i] + sum(Q[i,j] for j in range(N_BITS) if i!=j))
        qc.rz(float(2*gamma*field), i)
    for i in range(N_BITS):
        for j in range(i+1,N_BITS):
            interaction = Q[i,j] / 2
            if abs(interaction) > 1e-8:
                qc.rzz(float(2*gamma*interaction),i,j)
    for i in range(N_BITS): qc.rx(float(2*beta),i)
    qc.measure_all()
    return qc


def describe_circuit(qc, cap=240):
    operations=[]
    for inst in qc.data[:cap]:
        operations.append({"gate":inst.operation.name,
                           "qubits":[qc.find_bit(q).index for q in inst.qubits]})
    return {"qubits":qc.num_qubits,"logical_gates":qc.size(),
            "depth":qc.depth(),"operations":operations,
            "truncated":len(qc.data)>cap}


def local_qiskit(problem, shots=1024):
    from qiskit.primitives import StatevectorSampler
    qc=circuit(problem)
    counts=StatevectorSampler(seed=19).run([qc],shots=shots).result()[0].data.meas.get_counts()
    states=list(Counter({k:int(v) for k,v in counts.items()}).elements())
    result=summarize(states,problem,"ibm_simulator",gate_count=qc.size())
    result["circuit"]=describe_circuit(qc)
    return result


def submit_ibm(problem, shots=1024):
    from qiskit_ibm_runtime import QiskitRuntimeService, Sampler
    from qiskit.transpiler import generate_preset_pass_manager
    service=QiskitRuntimeService(channel="ibm_quantum_platform",token=__import__("os").environ["IBM_QUANTUM_TOKEN"])
    backend=service.least_busy(operational=True,simulator=False,min_num_qubits=N_BITS)
    isa=generate_preset_pass_manager(backend=backend,optimization_level=1).run(circuit(problem))
    job=Sampler(backend).run([isa],shots=shots)
    return {"provider_job_id":job.job_id(),"backend":backend.name,
            "transpiled_gate_count":isa.size(),
            "logical_gate_count":circuit(problem).size(),"circuit":describe_circuit(isa),"status":"submitted"}


def poll_ibm(provider_job_id,problem):
    from qiskit_ibm_runtime import QiskitRuntimeService
    job=QiskitRuntimeService(channel="ibm_quantum_platform",token=__import__("os").environ["IBM_QUANTUM_TOKEN"]).job(provider_job_id)
    status=str(job.status()).lower()
    if "done" not in status and "complete" not in status:
        if any(x in status for x in ["error","cancel","fail"]):
            raise RuntimeError(f"ibm job failed: {status}")
        return {"status":"submitted","provider_job_id":provider_job_id}
    counts=job.result()[0].data.meas.get_counts()
    states=list(Counter({k:int(v) for k,v in counts.items()}).elements())
    return {"status":"completed","result":summarize(states,problem,"ibm_quantum",provider_job_id=provider_job_id)}


def extropic_thrml(problem, shots=1024):
    """THRML block-Gibbs simulation of the shared Ising energy model (CPU/JAX).
    No claim of physical Extropic hardware access.
    """
    import jax
    import jax.numpy as jnp
    from thrml import SpinNode, Block, SamplingSchedule, sample_states
    from thrml.models import IsingEBM, IsingSamplingProgram, hinton_init
    Q,l=problem["q"],problem["linear"]
    # E(b) = b'Qb + l'b; b=(s+1)/2.
    # THRML EBM convention: p(s) proportional exp(beta*(bias*s + W*s*s)).
    # biases/weights are negatives of the corresponding energy coefficients.
    nodes=[SpinNode() for _ in range(N_BITS)]
    edges=[(nodes[i],nodes[j]) for i in range(N_BITS) for j in range(i+1,N_BITS)]
    biases=jnp.asarray([-(l[i]+Q[i,i]+sum(Q[i,j] for j in range(N_BITS) if i!=j))/2 for i in range(N_BITS)])
    weights=jnp.asarray([-Q[i,j]/2 for i in range(N_BITS) for j in range(i+1,N_BITS)])
    model=IsingEBM(nodes,edges,biases,weights,jnp.array(1.8))
    # Complete interaction graph: each spin needs its own independent block.
    blocks=[Block([n]) for n in nodes]
    program=IsingSamplingProgram(model,blocks,clamped_blocks=[])
    key=jax.random.key(42)
    k1,k2=jax.random.split(key)
    init=hinton_init(k1,model,blocks,())
    schedule=SamplingSchedule(n_warmup=150,n_samples=shots,steps_per_sample=8)
    raw=sample_states(k2,program,schedule,init,[],[Block(nodes)])[0]
    states=["".join(str(int(bit)) for bit in sample[::-1]) for sample in np.asarray(raw)]
    return summarize(states,problem,"extropic_simulator")


def run(provider):
    problem=make_problem()
    if provider=="classical":return exact(problem)
    if provider=="ibm_simulator":return local_qiskit(problem)
    if provider=="extropic_simulator":return extropic_thrml(problem)
    raise ValueError("physical ibm submits asynchronously through submit_ibm")

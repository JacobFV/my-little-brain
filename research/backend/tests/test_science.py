"""The scientific kernel: encoding, forward model, QUBO/Ising algebra, QAOA correctness, evaluation honesty."""
import itertools

import numpy as np
import pytest

from cortex2 import classical, inverse as inv, neural as nm, quantum as qm


def test_encoding_roundtrip():
    for k in range(nm.N_STATES):
        bits = nm.all_bits()[k]
        assert nm.grid_index(bits) == k
        assert (nm.bitstring_to_bits(nm.bits_to_bitstring(bits)) == bits).all()
        assert (nm.levels_to_bits(nm.bits_to_levels(bits))[0] == bits).all()


def test_forward_is_deterministic_and_noise_seed_matters():
    p = nm.levels_to_params([[3, 2, 2, 2]])
    a, b = nm.forward(p), nm.forward(p)
    np.testing.assert_allclose(a, b)
    c = nm.features(nm.simulate(p, seed=999), nm.SIM_FS)
    assert np.abs(a - c).max() > 1e-4


def test_grid_is_mostly_identifiable():
    hits = 0
    for seed in range(10):
        t = inv.synthetic_target(rng_seed=seed)
        losses = inv.nonlinear_losses(t)
        k = nm.grid_index(t.truth_bits)
        assert losses[k] <= inv.consistency_threshold(t, losses)   # truth always observationally consistent
        hits += int(np.argmin(losses) == k)
    assert hits >= 6


@pytest.mark.parametrize("method", inv.APPROXIMATIONS)
def test_qubo_to_ising_is_exact(method):
    t = inv.synthetic_target("10101011")
    q = inv.build_qubo(t, method, baseline="10100011", trust_weight=0.3)
    ising = q.to_ising()
    z = 1 - 2 * nm.all_bits()
    e = ising.offset + z @ ising.h + sum(ising.J[i, j] * z[:, i] * z[:, j] for i in range(8) for j in range(i + 1, 8))
    np.testing.assert_allclose(e, q.energies(), atol=1e-8)


def test_secant_qubo_is_exact_for_linear_model():
    t = inv.synthetic_target("10101011")
    q = inv.build_qubo(t, "secant")
    table = nm.forward_table().features
    J = inv._bit_secant(np.zeros(8, dtype=int))
    for bits in itertools.islice(itertools.product((0, 1), repeat=8), 0, 256, 17):
        b = np.array(bits)
        r = table[0] + J @ b - t.features
        assert abs(q.energy(b) - float((r ** 2 * t.weights).sum())) < 1e-9


def test_numpy_qaoa_matches_qiskit_statevector():
    t = inv.synthetic_target("10101011")
    q = inv.build_qubo(t, "trust_region", baseline="10100011", trust_weight=0.15)
    ising = q.to_ising()
    for spec in [qm.CircuitSpec(reps=1, max_couplings=6), qm.CircuitSpec(reps=2, warm_start="10100011")]:
        spec.gammas, spec.betas, _ = qm.optimise_angles(ising, spec, restarts=2)
        qc = qm.build_qaoa(ising, spec)
        ideal = qm.ideal_distribution(qc)
        p_np = qm.qaoa_probabilities(qm.circuit_cost_diagonal(ising, spec), spec.gammas, spec.betas, spec)
        p_q = np.array([ideal.get(nm.bits_to_bitstring(b), 0) for b in nm.all_bits()])
        np.testing.assert_allclose(p_np, p_q, atol=1e-7)


def test_pruning_reduces_physical_gates_into_budget():
    t = inv.synthetic_target("10101011")
    ising = inv.build_qubo(t, "secant").to_ising()
    full = qm.CircuitSpec(reps=1)
    pruned = qm.CircuitSpec(reps=1, max_couplings=6)
    stats = []
    for spec in (full, pruned):
        spec.gammas, spec.betas = [0.5], [0.4]
        _, s = qm.transpile(qm.build_qaoa(ising, spec))
        stats.append(s)
    assert stats[1]["gates"] < stats[0]["gates"]
    assert stats[1]["within_budget"]


def test_qasm_validation():
    good = 'OPENQASM 2.0;\ninclude "qelib1.inc";\nqreg q[8];\ncreg c[8];\nh q;\nrzz(0.3) q[0],q[1];\nmeasure q -> c;\n'
    qc = qm.parse_qasm(good)
    assert qc.num_qubits == 8
    with pytest.raises(ValueError):
        qm.parse_qasm(good.replace("qreg q[8]", "qreg q[9]").replace("creg c[8]", "creg c[9]"))
    no_measure = good.replace("measure q -> c;\n", "")
    assert "measure" in qm.parse_qasm(no_measure).count_ops()


def test_evaluation_uses_validation_budget_and_reports_truth():
    t = inv.synthetic_target("10101011")
    counts, _ = classical.random_counts(1024, seed=1)
    ev = inv.evaluate_counts(t, counts, validation_budget=4)
    assert len(ev["validated"]) == 4
    assert ev["best_nonlinear_loss"] >= ev["best_any_sample"]["nonlinear_loss"]
    assert abs(ev["approximation_ratio"]) < 0.2            # random ≈ 0
    exact, _ = classical.exact_counts(t)
    ev2 = inv.evaluate_counts(t, exact, validation_budget=1)
    assert ev2["best_nonlinear_loss"] == pytest.approx(ev2["min_possible_loss"])
    assert ev2["truth"]["recovered_exactly"]


def test_annealer_beats_random_on_qubo():
    t = inv.synthetic_target("10101011")
    q = inv.build_qubo(t, "secant")
    a, _ = classical.anneal_counts(q, 512)
    r, _ = classical.random_counts(512)
    e = q.energies()
    mean = lambda c: sum(n * e[nm.grid_index(nm.bitstring_to_bits(s))] for s, n in c.items()) / sum(c.values())
    assert mean(a) < mean(r)


def test_thrml_matches_boltzmann():
    pytest.importorskip("thrml")
    from cortex2 import thermo
    t = inv.synthetic_target("10101011")
    ising = inv.build_qubo(t, "secant").to_ising()
    counts, meta = thermo.sample(ising, 2048, beta=2.0)
    assert sum(counts.values()) == 2048
    assert qm.total_variation(qm.normalise(counts), thermo.boltzmann_reference(ising, 2.0)) < 0.15


def test_seizure_excerpt_separates_preictal_and_ictal():
    from cortex2 import eeg
    best = {}
    for seg in ("preictal", "ictal"):
        x, fs, _ = eeg.segment("chbmit-chb01_03", "T7-P7", seg)
        losses = inv.nonlinear_losses(inv.recording_target(x, fs, seg))
        best[seg] = nm.forward_table().params[int(np.argmin(losses))]
    assert not np.allclose(best["preictal"], best["ictal"])

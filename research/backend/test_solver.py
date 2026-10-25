"""Fast smoke checks: cannot overclaim the synthetic inverse benchmark."""
import itertools
import numpy as np
import solver


def test_forward_is_deterministic():
    bits=np.array(solver.TRUE_BITS)
    np.testing.assert_allclose(solver.forward(bits),solver.forward(bits))


def test_energy_matches_local_quadratic():
    p=solver.make_problem()
    for bits in itertools.product((0,1),repeat=solver.N_BITS):
        b=np.array(bits)
        y=p["matrix"]@b + p["origin"] - p["target"]
        assert abs(solver.energy(b,p)-float(y@y)) < 1e-8


def test_exact_recovers_known_synthetic_configuration():
    p=solver.make_problem()
    result=solver.exact(p)
    assert result["all_states_searched"]==256
    assert result["objective"] < 1e-12
    assert result["candidates"][0]["bitstring"]=="".join(map(str,solver.TRUE_BITS[::-1]))
    assert result["scientific_scope"]=="synthetic benchmark, not epilepsy diagnosis"


def test_parameter_bounds():
    for bits in itertools.product((0,1),repeat=solver.N_BITS):
        params=solver.unpack(bits)
        assert np.all(params>=0) and np.all(params<=1)


def test_qaoa_circuit_when_qiskit_available():
    try:import qiskit  # noqa: F401
    except ImportError:return
    q=solver.circuit(solver.make_problem())
    assert q.num_qubits==8
    assert q.num_clbits==8
    assert q.size()>20
    assert solver.describe_circuit(q)["operations"]

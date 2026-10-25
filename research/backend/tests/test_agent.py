"""Agent loop with a scripted stand-in for the Responses API (no network)."""

import pytest

from cortex2 import agent, llm, runner
from cortex2.store import store

QASM = """OPENQASM 2.0;
include "qelib1.inc";
qreg q[8];
creg c[8];
x q[0]; x q[1]; x q[3]; x q[5]; x q[7];
h q[2]; h q[4]; h q[6];
measure q -> c;
"""


class ScriptedBackend:
    """Stand-in provider: plays a fixed tool-call script and keeps every request it was sent."""
    family, model, label = "fake", "scripted", "fake/scripted"

    def __init__(self, script):
        self.script, self.requests = script, []

    def available(self):
        return True

    def complete(self, system, history, tools, effort=""):
        self.requests.append([dict(m) for m in history])
        step = self.script[min(len(self.requests) - 1, len(self.script) - 1)]
        calls = [{"id": f"c{len(self.requests)}{i}", "name": n, "args": a} for i, (n, a) in enumerate(step)]
        return llm.Turn("" if calls else "done", calls, None, self.label, f"r{len(self.requests)}")


@pytest.fixture
def fake():
    holder = {}

    def install(script):
        holder["backend"] = ScriptedBackend(script)
        llm.set_router(llm.Router([holder["backend"]]))
        return holder["backend"]
    holder["install"] = install
    yield holder
    llm.set_router(None)


def test_design_iteration_records_measured_verdict(fake):
    exp = runner.create_experiment("agent-user", {"source": "synthetic", "truth_bitstring": "10101011"})
    ref = runner.create_job("agent-user", exp["id"], {"provider": "aer_noisy", "approximation": "secant",
                                                      "spec": {"reps": 1, "max_couplings": 6}, "shots": 256}, enqueue=False)
    ref = runner.execute_sample_job(store().get("jobs", ref["id"]))
    backend = fake["install"]([
        [("inspect_state", {})],
        [("compile_circuit", {"approximation": "trust_region", "qasm": QASM})],
        [("run_experiment", {"provider": "aer_noisy", "approximation": "trust_region", "qasm": QASM, "shots": 256})],
        [("record_revision", {"observation": "secant QUBO concentrates far from the optimum",
                              "diagnosis": "linearisation point is poor", "change": "hand-written warm-start circuit",
                              "rationale": "bias toward the best validated region", "reference_job_id": ref["id"]})],
    ])
    job = store().create("jobs", {"owner": "agent-user", "experiment_id": exp["id"], "kind": "agent_iteration", "status": "running",
                                  "created_at": "x", "created_by": "user"})
    done = agent.run_iteration(store().get("jobs", job["id"]))
    assert done["status"] == "completed"
    rev = store().get("revisions", done["revision_id"])
    assert rev["reference_job_id"] == ref["id"] and rev["revised_job_id"]
    assert rev["custom_qasm"] is True and rev["qasm_diff"]
    assert rev["verdict"] in ("improved", "regressed", "unchanged")
    expected = agent.verdict(store().get("jobs", ref["id"]), store().get("jobs", rev["revised_job_id"]), rev["best_known_before"])
    assert rev["verdict"] == expected                         # computed, not claimed
    assert rev["comparison_basis"] == "model_specified" and rev["information"] == "blind"
    assert rev["forward_simulations_after"] >= rev["forward_simulations_before"]
    assert [t["tool"] for t in rev["tool_trace"]] == ["inspect_state", "compile_circuit", "run_experiment", "record_revision"]
    # the rendered comparison image was sent to the model after run_experiment
    sent = backend.requests[3]
    assert sent[-1]["role"] == "tool" and sent[-1]["images"] and sent[-1]["images"][0].startswith(b"\x89PNG")
    assert rev["model"] == "fake/scripted" and rev["provenance"]


class Failing:
    family, model = "fake", "x"

    def __init__(self, label, kind):
        self.label, self.kind, self.calls = label, kind, 0

    def available(self):
        return True

    def complete(self, *a, **k):
        self.calls += 1
        raise llm.ProviderError(self.kind, f"{self.label} {self.kind}")


def test_router_fails_over_and_cools_down():
    quota, rate = Failing("a", "quota"), Failing("b", "rate")
    ok = ScriptedBackend([[]])
    r = llm.Router([quota, rate, ok])
    assert r.complete("s", [{"role": "user", "text": "hi"}], []).provider == "fake/scripted"
    r.complete("s", [{"role": "user", "text": "hi"}], [])
    assert quota.calls == 1 and rate.calls == 1          # cooled-down providers are skipped next time
    status = {s["provider"]: s["cooling_down"] for s in r.status()}
    assert status["a"] == "quota" and status["b"] == "rate"
    bad = Failing("c", "bad_request")
    with pytest.raises(RuntimeError):
        llm.Router([bad, ScriptedBackend([[]])]).complete("s", [{"role": "user", "text": "x"}], [])


def test_chain_parsing(monkeypatch):
    monkeypatch.setenv("GEMINI_MODEL", "gemini-4-argon")
    chain = llm.parse_chain("gemini:GEMINI_API_KEY,gemini:GEMINI_API_KEY_B@gemini-3.8-flash,openai:OPENAI_API_KEY")
    assert [(b.family, b.key_env, b.model) for b in chain] == [
        ("gemini", "GEMINI_API_KEY", "gemini-4-argon"), ("gemini", "GEMINI_API_KEY_B", "gemini-3.8-flash"),
        ("openai", "OPENAI_API_KEY", "gpt-6.1-sol")]
    with pytest.raises(ValueError):
        llm.parse_chain("claude:KEY")


def test_gemini_history_conversion_handles_foreign_calls():
    pytest.importorskip("google.genai")
    b = llm.GeminiBackend("GEMINI_API_KEY", "gemini-4-argon")
    hist = [{"role": "user", "text": "go", "images": [b"\x89PNGfake"]},
            {"role": "model", "text": "", "calls": [{"id": "1", "name": "inspect_state", "args": {}}], "family": "openai", "raw": [{"x": 1}]},
            {"role": "tool", "results": [{"id": "1", "name": "inspect_state", "result": {"ok": True}}], "images": [b"\x89PNGimg"]}]
    contents = b._contents(hist)
    assert [c.role for c in contents] == ["user", "model", "user"]
    assert contents[1].parts[0].function_call.name == "inspect_state" and contents[1].parts[0].thought_signature
    assert contents[2].parts[0].function_response.name == "inspect_state" and contents[2].parts[-1].inline_data


def test_openai_history_conversion():
    b = llm.OpenAIBackend("OPENAI_API_KEY", "gpt-6.1-sol")
    hist = [{"role": "user", "text": "go"},
            {"role": "model", "text": "", "calls": [{"id": "c1", "name": "t", "args": {"a": 1}}], "family": "gemini", "raw": object()},
            {"role": "tool", "results": [{"id": "c1", "name": "t", "result": {"ok": 1}}], "images": [b"png"]}]
    items = b._input(hist)
    kinds = [i.get("type") or i.get("role") for i in items]
    assert kinds == ["user", "function_call", "function_call_output", "user"]


# ---------------------------------------------------------------- blind information, economics, continuity

ORACLE_KEYS = ("min_possible_loss", "approximation_ratio", "p_consistent", "truth", "qubo_quality", "oracle")


def _deep_keys(x):
    if isinstance(x, dict):
        for k, v in x.items():
            yield k
            yield from _deep_keys(v)
    elif isinstance(x, list):
        for v in x:
            yield from _deep_keys(v)


def test_agent_sees_no_oracle_information():
    exp = runner.create_experiment("blind-user", {"source": "synthetic", "truth_bitstring": "10101011"})
    j = runner.create_job("blind-user", exp["id"], {"provider": "classical_anneal", "approximation": "trust_region"}, enqueue=False)
    runner.execute_sample_job(store().get("jobs", j["id"]))
    exp = store().get("experiments", exp["id"])
    ds = agent.DesignSession({"owner": "blind-user", "experiment_id": exp["id"], "id": "x"})
    views = [agent.experiment_state(exp), ds.build_problem("trust_region")[0],
             ds.compile_circuit("trust_region", spec={"reps": 1, "max_couplings": 4})[0]]
    for view in views:
        leaked = [k for k in _deep_keys(view) if any(o in k for o in ORACLE_KEYS)]
        assert not leaked, leaked
    state = views[0]
    assert state["economics"]["forward_simulations_used"] == len(state["simulated_hypotheses"]) > 0
    assert "classical_exact" not in agent.SYNC_PROVIDERS
    with_oracle = agent.experiment_state(exp, oracle=True)
    assert "oracle_loss_stats" in with_oracle["problem"]


def test_identical_configuration_is_not_rerun():
    exp = runner.create_experiment("dedup-user", {"source": "synthetic", "truth_bitstring": "00110010"})
    ds = agent.DesignSession({"owner": "dedup-user", "experiment_id": exp["id"], "id": "it1"})
    first, png = ds.run_experiment("classical_anneal", "trust_region", baseline="00000000", shots=256)
    assert png is not None and png.startswith(b"\x89PNG") and "not_rerun" not in first
    used = first["economics"]["forward_simulations_used"]
    again, png2 = ds.run_experiment("classical_anneal", "trust_region", baseline="00000000", shots=256)
    assert again["not_rerun"] and again["duplicate_of"] == first["job"]["id"] and png2 is None
    assert agent.economics(store().get("experiments", exp["id"]))["forward_simulations_used"] == used
    forced, _ = ds.run_experiment("classical_anneal", "trust_region", baseline="00000000", shots=256, force_rerun=True)
    assert "not_rerun" not in forced and forced["job"]["id"] != first["job"]["id"]


def _job(jid, provider, shots, loss, ar, created, gates=100):
    return {"id": jid, "kind": "sample", "provider": provider, "shots": shots, "created_at": created,
            "evaluation": {"best_nonlinear_loss": loss, "p_consistent": 0.1, "approximation_ratio": ar},
            "transpiled": {"gates": gates, "within_budget": True}}


def test_reference_selection_prefers_equal_footing():
    revised = _job("r", "aer_noisy", 1024, 1.0, 0.5, "3")
    prior = [_job("a", "thrml", 1024, 0.5, 0.9, "1"), _job("b", "aer_noisy", 1024, 2.0, 0.2, "2"),
             _job("c", "aer_noisy", 512, 1.5, 0.3, "2.5")]
    ref, basis = agent.choose_reference(None, revised, prior, prior[0])
    assert ref["id"] == "b" and basis == "same_provider"
    ref, basis = agent.choose_reference(prior[0], revised, prior, None)
    assert ref["id"] == "a" and basis == "model_specified_cross_provider"
    ref, basis = agent.choose_reference(None, _job("z", "ionq_simulator", 64, 1, .1, "4"), prior, prior[0])
    assert ref["id"] == "a" and basis == "experiment_best"


def test_verdict_progress_and_distribution_quality():
    ref, rev = _job("a", "aer_noisy", 1024, 0.5, 0.40, "1"), _job("b", "aer_noisy", 1024, 0.9, 0.70, "2")
    assert agent.verdict(ref, rev, best_known_before=0.5) == "improved"          # better distribution, no new best
    assert agent.verdict(rev, ref, best_known_before=0.5) == "regressed"
    lucky = _job("c", "aer_noisy", 1024, 0.3, 0.10, "3")
    assert agent.verdict(ref, lucky, best_known_before=0.5) == "improved"        # new best validated hypothesis
    same = _job("d", "aer_noisy", 1024, 0.9, 0.41, "4", gates=100)
    assert agent.verdict(ref, same, best_known_before=0.5) == "unchanged"
    assert agent.verdict(None, same, best_known_before=None) == "untested"


def test_iteration_carries_previous_next_step(fake):
    uid = "carry-user"
    exp = runner.create_experiment(uid, {"source": "synthetic", "truth_bitstring": "11111011"})
    store().create("revisions", {"owner": uid, "experiment_id": exp["id"], "number": 1, "created_at": "1",
                                 "verdict": "improved", "change": "switched to feature_regression",
                                 "next_step": "re-anchor the trust region around 10111111"})
    backend = fake["install"]([
        [("run_experiment", {"provider": "classical_anneal", "approximation": "trust_region", "shots": 256})],
        [("record_revision", {"observation": "o", "diagnosis": "d", "change": "c", "rationale": "r"})],
    ])
    job = store().create("jobs", {"owner": uid, "experiment_id": exp["id"], "kind": "agent_iteration", "status": "running",
                                  "created_at": "x", "created_by": "user"})
    done = agent.run_iteration(store().get("jobs", job["id"]))
    first = backend.requests[0][0]["text"]
    assert "re-anchor the trust region around 10111111" in first and "Forward simulations used so far: 0/256" in first
    rev = store().get("revisions", done["revision_id"])
    assert rev["number"] == 2 and rev["verdict"] == "untested" and rev["comparison_basis"] == "none"

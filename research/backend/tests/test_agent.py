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
    expected = agent.verdict(store().get("jobs", ref["id"]), store().get("jobs", rev["revised_job_id"]))
    assert rev["verdict"] == expected                         # computed, not claimed
    assert [t["tool"] for t in rev["tool_trace"]] == ["inspect_state", "compile_circuit", "run_experiment", "record_revision"]
    # the rendered comparison image was sent to the model after run_experiment
    sent = backend.requests[3]
    assert sent[-1]["role"] == "tool" and sent[-1]["images"] and sent[-1]["images"][0].startswith(b"\x89PNG")
    assert rev["model"] == "fake/scripted" and rev["provenance"]


def test_operator_respects_budgets(fake):
    uid = "op-user"
    exp = runner.create_experiment(uid, {"source": "synthetic", "truth_bitstring": "00110010"})
    agent.update_session(uid, {"max_autonomous_jobs": 1})
    fake["install"]([
        [("dispatch_job", {"experiment_id": exp["id"], "provider": "classical_anneal", "approximation": "secant"}),
         ("dispatch_job", {"experiment_id": exp["id"], "provider": "classical_anneal", "approximation": "jacobian"}),
         ("dispatch_job", {"experiment_id": exp["id"], "provider": "ibm_quantum", "approximation": "secant"})],
        [("update_memory", {"memory": "testing budgets"})],
        [],
    ])
    job = store().create("jobs", {"owner": uid, "kind": "agent_operator", "status": "running", "created_at": "x",
                                  "created_by": "agent", "command": "tick"})
    done = agent.run_operator(store().get("jobs", job["id"]))
    actions = done["result"]["actions"]
    assert len([a for a in actions if a["action"] == "dispatch"]) == 1     # second denied by budget, QPU denied
    assert agent.session(uid)["operator_memory"] == "testing budgets"


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

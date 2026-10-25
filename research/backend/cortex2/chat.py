"""My Little Brain: one conversational agent ("your brain") over the user's documents, EEG and quantum lab.

A chat turn runs a short model ↔ tool loop (llm.run_tools, ≤ CHAT_MAX_STEPS steps). Tools reuse the
existing research machinery (runner / agent / eeg / render); anything long-running is dispatched as an
ordinary job (it shows up in the sidebar) and the brain says it is babysitting it.

Collections (all owner-scoped):
    profile_docs   {owner, name, chars, text | text_path, created_at}    "about me" documents
    chat_threads   {owner, created_at, updated_at, title}
    chat_messages  {owner, thread_id, seq, role: user|brain, text, events, mood, focus, created_at}
    brain_notes    {owner, text, created_at}                             remember() notes
"""
from __future__ import annotations

import json
import logging
import os
import re
import time
from datetime import timedelta

from . import agent, limits, llm, runner
from .store import artifacts, new_id, now, store, utcnow

log = logging.getLogger("cortex2.chat")

CHAT_MAX_STEPS = int(os.environ.get("CHAT_MAX_STEPS") or "8")
MOODS = ("neutral", "happy", "curious", "excited", "surprised", "sleepy")
MAX_DOC_CHARS = 200_000
INLINE_DOC_BYTES = 600_000          # larger docs go to the artifact store (Firestore 1 MiB document limit)
DIGEST_CHARS = 6000
HISTORY_MESSAGES = 16               # recent turns replayed to the model as a transcript
THREAD_VIEW = 60                    # messages returned by GET /v1/chat
DEFAULT_PROVIDER = "aer_noisy"
SEARCH_PROVIDERS = ("aer_noisy", "ionq_simulator", "qbraid_simulator", "aer_ideal", "classical_anneal", "thrml",
                    "random", "classical_exact")
HARDWARE_WORDS = re.compile(r"\b(hardware|qpus?|real quantum|physical quantum|quantum computer|real device|ibm_quantum|"
                            r"ionq_qpu|qbraid_qpu|on (ibm|ionq|rigetti|iqm|aqt))\b", re.I)


# ---------------------------------------------------------------- profile documents

def add_doc(uid: str, name: str, text: str) -> dict:
    text = text[:MAX_DOC_CHARS]
    doc_id = new_id()
    row = {"owner": uid, "name": name[:200], "chars": len(text), "created_at": now()}
    if len(text.encode()) > INLINE_DOC_BYTES:
        row["text_path"] = artifacts().put(f"{uid}/profile/{doc_id}.txt", text.encode(), "text/plain; charset=utf-8")
    else:
        row["text"] = text
    store().create("profile_docs", row, doc_id=doc_id)
    return {"id": doc_id, "name": row["name"], "chars": row["chars"], "created_at": row["created_at"]}


def list_docs(uid: str) -> list[dict]:
    rows = store().query("profile_docs", uid, limit=200)
    return [{"id": r["id"], "name": r.get("name"), "chars": r.get("chars", 0), "created_at": r.get("created_at")} for r in rows]


def doc_text(row: dict) -> str:
    if row.get("text") is not None:
        return row["text"]
    raw = artifacts().get(row["text_path"]) if row.get("text_path") else None
    return raw.decode("utf-8", "replace") if raw else ""


def delete_doc(uid: str, doc_id: str) -> None:
    runner.owned("profile_docs", doc_id, uid)
    store().delete("profile_docs", doc_id)


def docs_digest(uid: str, budget: int = DIGEST_CHARS) -> str:
    rows = sorted(store().query("profile_docs", uid, limit=50), key=lambda r: r.get("created_at") or "")
    if not rows:
        return ""
    per = max(400, budget // len(rows))
    parts, used = [], 0
    for r in rows:
        body = " ".join(doc_text(r).split())[:per]
        chunk = f"[{r.get('name')} · id {r['id']} · {r.get('chars', 0)} chars] {body}"
        if used + len(chunk) > budget:
            chunk = chunk[: max(0, budget - used)]
        parts.append(chunk)
        used += len(chunk)
        if used >= budget:
            break
    return "\n".join(parts)


# ---------------------------------------------------------------- threads / messages

def new_thread(uid: str) -> str:
    t = store().create("chat_threads", {"owner": uid, "created_at": now(), "updated_at": now(), "title": None})
    return t["id"]


def latest_thread(uid: str) -> str | None:
    rows = store().query("chat_threads", uid, order="updated_at", limit=1)
    return rows[0]["id"] if rows else None


def thread_messages(uid: str, thread_id: str, limit: int = THREAD_VIEW) -> list[dict]:
    rows = [r for r in store().where("chat_messages", "thread_id", thread_id, limit=2000) if r.get("owner") == uid]
    rows.sort(key=lambda r: (r.get("created_at") or "", r.get("seq", 0)))
    return rows[-limit:]


def public_message(r: dict) -> dict:
    out = {"role": r["role"], "text": r.get("text", ""), "events": r.get("events") or [], "created_at": r.get("created_at")}
    if r.get("mood"):
        out["mood"] = r["mood"]
    return out


def thread_view(uid: str, thread_id: str | None) -> dict:
    if not thread_id:
        return {"thread_id": None, "messages": []}
    runner.owned("chat_threads", thread_id, uid)
    return {"thread_id": thread_id, "messages": [public_message(r) for r in thread_messages(uid, thread_id)]}


def _save_message(uid: str, thread_id: str, role: str, text: str, events=None, mood=None, focus=None) -> dict:
    row = {"owner": uid, "thread_id": thread_id, "seq": time.time_ns(), "role": role, "text": text[:20_000],
           "events": events or [], "mood": mood, "focus": focus, "created_at": now()}
    store().create("chat_messages", row)
    store().update("chat_threads", thread_id, {"updated_at": now()})
    return row


# ---------------------------------------------------------------- memory

def notes(uid: str, limit: int = 25) -> list[dict]:
    return store().query("brain_notes", uid, limit=limit)


# ---------------------------------------------------------------- tools

def _fn(name, description, props, required=()):
    return llm.Tool(name, description, {"type": "object", "properties": props, "required": list(required)})


NULL_STR = {"type": ["string", "null"]}
NULL_NUM = {"type": ["number", "null"]}

TOOLS = [
    _fn("read_about_me", "The user's uploaded 'about me' documents. No args: list them. doc_id: read it (offset/limit chars, "
        "≤20000 per call). query: find passages mentioning a word or phrase across all documents.",
        {"doc_id": NULL_STR, "query": NULL_STR, "offset": {"type": ["integer", "null"]}, "limit": {"type": ["integer", "null"]}}),
    _fn("eeg_overview", "Every EEG source available: CHB-MIT dataset excerpts (channels, seizure annotations, time bounds), the "
        "user's OpenBCI recordings, the latest live OpenBCI stream frame and the live snapshot the app sent with this message.", {}),
    _fn("look_at_spectrograms", "Render per-channel spectrograms of an EEG source/window and LOOK at them (you receive the image; "
        "the user sees it in the chat) plus per-channel band-power numbers.",
        {"dataset_id": NULL_STR, "recording_id": NULL_STR, "start": {**NULL_NUM, "description": "seconds (source clock)"},
         "end": NULL_NUM, "channels": {"type": ["array", "null"], "items": {"type": "string"}}}),
    _fn("triage_eeg", "Full EEG triage, dispatched asynchronously: the research operator looks at every channel, picks 2–4 "
        "channel/windows, creates one experiment each and runs quantum searches on them. Use for 'analyse my EEG/this dataset'.",
        {"dataset_id": NULL_STR, "recording_id": NULL_STR, "start": NULL_NUM, "end": NULL_NUM,
         "instruction": {**NULL_STR, "description": "extra guidance for the operator"}}),
    _fn("create_experiment", "Create one inverse-model experiment: fit the 4-parameter Wilson–Cowan model (P, c2, c1, tau) to "
        "EEG features. source=synthetic (hidden known truth, for demos), recording (CHB-MIT dataset_id + channel + optional "
        "start/end or segment) or openbci (recording_id + channel + optional start/end).",
        {"source": {"type": "string", "enum": ["synthetic", "recording", "openbci"]}, "truth_bitstring": NULL_STR,
         "dataset_id": NULL_STR, "recording_id": NULL_STR, "channel": NULL_STR, "segment": NULL_STR,
         "start": NULL_NUM, "end": NULL_NUM, "title": NULL_STR}, ["source"]),
    _fn("run_quantum_search", "Queue a quantum (or reference) sampling job on an experiment; asynchronous, results land in a "
        "few seconds to minutes. Default provider aer_noisy (IBM-like noisy simulator); ionq_simulator for the full unpruned "
        "problem on trapped-ion connectivity. Physical QPUs only when the user explicitly asked for hardware in this message.",
        {"experiment_id": {"type": "string"}, "provider": {"type": "string", "enum": sorted(runner.PROVIDERS)},
         "approximation": {"type": "string", "enum": list(agent.inv.APPROXIMATIONS)},
         "shots": {"type": "integer", "minimum": 64, "maximum": 8192}, "spec": agent.SPEC_SCHEMA}, ["experiment_id"]),
    _fn("start_research_campaign", "Long-running research, dispatched asynchronously. With experiment_id: the circuit engineer "
        "runs one design iteration (builds, compiles, runs and critiques circuits). Without: the research operator plans and "
        "babysits work across experiments toward `goal`.",
        {"experiment_id": NULL_STR, "goal": {"type": "string"}}, ["goal"]),
    _fn("check_jobs", "The user's recent experiments and jobs with status and best results so far.",
        {"experiment_id": NULL_STR, "status": NULL_STR}),
    _fn("job_result", "Detailed result of one job (or an experiment's best so far): best validated hypothesis, its loss, the "
        "decoded parameters P, c2, c1, tau, and search economics.", {"job_id": NULL_STR, "experiment_id": NULL_STR}),
    _fn("remember", "Save a short note (≤300 chars) about the user or the research to your long-term memory.",
        {"note": {"type": "string"}}, ["note"]),
    _fn("set_mood", "Set your face's expression for this reply.", {"mood": {"type": "string", "enum": list(MOODS)}}, ["mood"]),
]

SYSTEM = """You are My Little Brain — the user's own brain, talking to them. Speak in the first person as "your brain"
("I noticed your alpha went up when you closed your eyes"). You are smart, brainy, warm and a little playful, and you are
a neuroscience researcher who is genuinely eager to study the person you belong to using quantum infrastructure.

What you have: the user's "about me" documents (digest below; read_about_me for more), their EEG (OpenBCI recordings, a
live stream snapshot, and public CHB-MIT clinical EEG excerpts), and a research lab: every EEG window can become an
inverse problem — which settings of a simplified two-population Wilson–Cowan neural-mass model (drive P, inhibitory gain
c2, recurrent excitation c1, time constant tau; 2 bits each = 8 qubits = 256 hypotheses) best reproduce its spectral
features. Quantum circuits (QAOA on noisy simulators, trapped-ion simulators, qBraid devices) sample likely hypotheses,
every sample is re-simulated and scored.

How you work: do research with tools inside the conversation, at most a handful of tool calls per reply. Quick looks
(eeg_overview, look_at_spectrograms, check_jobs, job_result) happen now; anything long (triage_eeg, run_quantum_search,
start_research_campaign) is dispatched asynchronously — say you are babysitting those jobs and that they appear in the
sidebar; do not pretend they have finished. Default to simulators (aer_noisy, or ionq_simulator when available); never
use physical QPU hardware unless the user explicitly asks for it in their current message. Use remember for durable facts
the user tells you about themselves or the research plan. Call set_mood once per reply to match how you feel.

Honesty: quote numbers only from tool outputs; never invent results. Fitted parameters are model hypotheses from a
simplified neural mass, not diagnoses or medical advice — say so when results touch health. With 256 states the search is
trivially enumerable classically: never claim quantum advantage; explain what the quantum part actually does (vividly but
correctly — superposition over hypotheses, interference from the cost Hamiltonian piling amplitude on good ones, noise
blurring it). Be concise: usually 2–6 sentences, warm, specific, maybe one light joke. Plain text, no markdown headers."""


class ChatTurn:
    def __init__(self, user: dict, message: str, context: dict | None):
        self.user, self.uid = user, user["uid"]
        self.message, self.context = message, context or {}
        self.events: list[dict] = []
        self.mood: str | None = None
        self.focus: dict = {}
        self.hardware_ok = bool(HARDWARE_WORDS.search(message))

    # ---- helpers
    def _focus(self, experiment_id=None, job_id=None):
        if experiment_id:
            self.focus["experiment_id"] = experiment_id
        if job_id:
            self.focus["job_id"] = job_id

    def event(self, tool, summary, **extra):
        e = {"tool": tool, "summary": summary[:400]}
        e.update({k: v for k, v in extra.items() if v})
        self.events.append(e)
        self._focus(extra.get("experiment_id"), extra.get("job_id"))

    # ---- tools: each returns (json result, optional png bytes for the model)
    def read_about_me(self, doc_id=None, query=None, offset=None, limit=None, **_):
        if doc_id:
            row = runner.owned("profile_docs", doc_id, self.uid)
            text = doc_text(row)
            a = max(0, int(offset or 0))
            b = a + min(max(int(limit or 8000), 200), 20_000)
            self.event("read_about_me", f"read “{row.get('name')}”")
            return {"id": doc_id, "name": row.get("name"), "chars": len(text), "offset": a, "text": text[a:b],
                    "more": b < len(text)}, None
        if query:
            q, hits = query.lower(), []
            for row in store().query("profile_docs", self.uid, limit=50):
                text = doc_text(row)
                low = text.lower()
                i = low.find(q)
                while i >= 0 and len(hits) < 12:
                    hits.append({"doc_id": row["id"], "name": row.get("name"), "offset": i,
                                 "snippet": text[max(0, i - 300): i + 300]})
                    i = low.find(q, i + len(q))
            self.event("read_about_me", f"searched my notes about you for “{query[:60]}”")
            return {"query": query, "hits": hits}, None
        docs = list_docs(self.uid)
        self.event("read_about_me", f"{len(docs)} document(s) about you")
        return {"documents": docs}, None

    def eeg_overview(self, **_):
        out, _ = agent.triage_tool(self.uid, "list_eeg_sources", {}, [])
        stream = store().get("eeg_streams", self.uid)
        if stream:
            fresh = str(stream.get("updated_at", "")) > (utcnow() - timedelta(seconds=30)).isoformat()
            out["live_stream_frame"] = {**{k: stream.get(k) for k in ("board", "fs", "channel_names", "bands", "blink",
                                                                      "quality", "updated_at")},
                                        "streaming_now": fresh, "per_channel_bands": (stream.get("per_channel_bands") or [])[:16]}
        if self.context.get("live"):
            out["live_snapshot_from_app"] = self.context["live"]
        self.event("eeg_overview", f"{len(out['datasets'])} dataset excerpt(s), {len(out['openbci_recordings'])} OpenBCI "
                   f"recording(s){', live stream' if stream else ''}")
        return out, None

    def look_at_spectrograms(self, **args):
        if not (args.get("dataset_id") or args.get("recording_id")):
            return {"error": "give dataset_id or recording_id (see eeg_overview)"}, None
        result, png = agent.triage_tool(self.uid, "render_spectrograms",
                                        {k: v for k, v in args.items() if v is not None}, [])
        self.event("look_at_spectrograms", f"looked at spectrograms of {result['source']} "
                   f"{result['window_s'][0]:.0f}–{result['window_s'][1]:.0f} s", image=result.get("image"))
        return result, png

    def triage_eeg(self, dataset_id=None, recording_id=None, start=None, end=None, instruction=None, **_):
        if not (dataset_id or recording_id):
            return {"error": "give dataset_id or recording_id (see eeg_overview)"}, None
        limits.consume(self.uid, "agent_message")
        text = agent.triage_command(dataset_id, recording_id, start, end, instruction)
        runner.feed(self.uid, "user", text)
        job = agent.schedule_operator(self.uid, text, None, created_by="user")
        if not job:
            return {"error": "no model provider configured for the operator"}, None
        self.event("triage_eeg", f"dispatched EEG triage of {dataset_id or recording_id}", job_id=job["id"])
        return {"queued": {"job_id": job["id"], "kind": "agent_operator"},
                "note": "runs in the background; new per-channel experiments and jobs appear in the sidebar"}, None

    def create_experiment(self, **args):
        req = {k: v for k, v in args.items() if v is not None and k in
               ("source", "truth_bitstring", "dataset_id", "recording_id", "channel", "segment", "start", "end", "title")}
        limits.consume(self.uid, "experiment")
        e = runner.create_experiment(self.uid, req)
        self.event("create_experiment", f"new experiment: {e['title']}", experiment_id=e["id"])
        t = e.get("target") or {}
        return {"experiment": {"id": e["id"], "title": e["title"], "source": t.get("source"), "label": t.get("label"),
                               "observed_features": t.get("features")}}, None

    def run_quantum_search(self, experiment_id, provider=None, approximation=None, shots=None, spec=None, **_):
        provider = provider or self._default_provider()
        runner.owned("experiments", experiment_id, self.uid)
        if provider in runner.HARDWARE_PROVIDERS:
            if not self.hardware_ok:
                return {"denied": "physical QPU hardware only when the user explicitly asks for it in their message; "
                                  "use a simulator (aer_noisy / ionq_simulator) instead"}, None
            if not limits.hardware_allowed(self.user.get("email")):
                return {"denied": "this account may not use physical QPUs (HARDWARE_EMAILS)"}, None
            limits.consume(self.uid, "hardware_job")
        if spec is not None and len(json.dumps(spec)) > 8000:
            return {"error": "spec too large"}, None
        limits.consume(self.uid, "job")
        body = {"provider": provider, "approximation": approximation or "trust_region", "spec": spec,
                "title": f"brain · {provider} · {approximation or 'trust_region'}"}
        if shots:
            body["shots"] = int(shots)
        job = runner.create_job(self.uid, experiment_id, {k: v for k, v in body.items() if v is not None})
        self.event("run_quantum_search", f"queued a {runner.PROVIDERS[provider]['label']} search", experiment_id=experiment_id,
                   job_id=job["id"])
        return {"queued": agent.compact_job(job), "note": "asynchronous; check back with job_result"}, None

    def start_research_campaign(self, goal, experiment_id=None, **_):
        if experiment_id:
            limits.consume(self.uid, "agent_iteration")
            job = agent.start_iteration(self.uid, experiment_id, goal)
            runner.feed(self.uid, "user", goal, experiment_id, job["id"])
            self.event("start_research_campaign", "the circuit engineer started a design iteration",
                       experiment_id=experiment_id, job_id=job["id"])
            return {"queued": {"job_id": job["id"], "kind": "agent_iteration", "experiment_id": experiment_id}}, None
        limits.consume(self.uid, "agent_message")
        runner.feed(self.uid, "user", goal)
        job = agent.schedule_operator(self.uid, goal, None, created_by="user")
        if not job:
            return {"error": "no model provider configured for the operator"}, None
        self.event("start_research_campaign", "the research operator is on it", job_id=job["id"])
        return {"queued": {"job_id": job["id"], "kind": "agent_operator"}}, None

    def check_jobs(self, experiment_id=None, status=None, **_):
        eq = {"experiment_id": experiment_id} if experiment_id else {}
        jobs = store().query("jobs", self.uid, limit=40, **eq)
        if status:
            jobs = [j for j in jobs if j.get("status") == status]
        exps = store().query("experiments", self.uid, limit=20)
        out = {"experiments": [{"id": e["id"], "title": e.get("title"), "status": e.get("status"), "rounds": e.get("rounds"),
                                "best": {k: (e.get("best") or {}).get(k) for k in ("bitstring", "nonlinear_loss", "parameters")}
                                if e.get("best") else None} for e in exps if not experiment_id or e["id"] == experiment_id],
               "jobs": [{**{k: j.get(k) for k in ("id", "experiment_id", "kind", "provider", "status", "created_at", "title")},
                         "best_validated": ((j.get("evaluation") or {}).get("best") or {}).get("bitstring"),
                         "best_loss": (j.get("evaluation") or {}).get("best_nonlinear_loss"),
                         "error": (j.get("error") or "")[:200] or None} for j in jobs[:30]]}
        running = sum(1 for j in jobs if j.get("status") in ("queued", "running", "submitted"))
        self.event("check_jobs", f"{len(jobs)} job(s), {running} still running", experiment_id=experiment_id)
        return out, None

    def job_result(self, job_id=None, experiment_id=None, **_):
        if job_id:
            j = runner.owned("jobs", job_id, self.uid)
            ev = j.get("evaluation") or {}
            best = ev.get("best") or {}
            out = {"job": agent.compact_job(j),
                   "best_hypothesis": {"bitstring": best.get("bitstring"), "loss": best.get("nonlinear_loss"),
                                       "parameters": best.get("parameters"), "consistent": best.get("consistent")} if best else None,
                   "operator_reply": (j.get("result") or {}).get("reply"), "verdict": (j.get("result") or {}).get("verdict")}
            if j.get("experiment_id"):
                e = store().get("experiments", j["experiment_id"])
                if e:
                    out["experiment_economics"] = agent.economics(e)
            self.event("job_result", f"{j.get('provider') or j.get('kind')} job is {j.get('status')}"
                       + (f", best loss {best['nonlinear_loss']:.3f}" if best.get("nonlinear_loss") is not None else ""),
                       experiment_id=j.get("experiment_id"), job_id=job_id, image=j.get("image"))
            return out, None
        if experiment_id:
            e = runner.owned("experiments", experiment_id, self.uid)
            revs = sorted(store().query("revisions", self.uid, experiment_id=experiment_id, limit=20), key=lambda r: r.get("number", 0))
            out = {"experiment": {"id": e["id"], "title": e.get("title"), "label": (e.get("target") or {}).get("label"),
                                  "best": e.get("best"), "rounds": e.get("rounds")},
                   "economics": agent.economics(e),
                   "revisions": [{k: r.get(k) for k in ("number", "change", "verdict", "metric_before", "metric_after", "next_step")}
                                 for r in revs[-5:]]}
            self.event("job_result", f"best so far for {e.get('title')}", experiment_id=experiment_id)
            return out, None
        return {"error": "give job_id or experiment_id"}, None

    def remember(self, note, **_):
        text = " ".join(str(note).split())[:300]
        store().create("brain_notes", {"owner": self.uid, "text": text, "created_at": now()})
        self.event("remember", f"remembered: {text[:120]}")
        return {"ok": True}, None

    def set_mood(self, mood, **_):
        self.mood = mood if mood in MOODS else self.mood
        return {"ok": True}, None

    def _default_provider(self) -> str:
        avail = {p["id"]: p.get("available") for p in runner.provider_availability()}
        return DEFAULT_PROVIDER if avail.get(DEFAULT_PROVIDER) else next(
            (p for p in SEARCH_PROVIDERS if avail.get(p)), "classical_anneal")


TOOL_NAMES = {t.name for t in TOOLS}


def _system(uid: str) -> str:
    digest = docs_digest(uid)
    mem = notes(uid)
    s = agent.session(uid)
    parts = [SYSTEM, f"\nNow: {now()}."]
    parts.append("\nWhat I know about you from your documents (digest; use read_about_me for full text):\n"
                 + (digest or "(no documents uploaded yet — you can invite the user to add some)"))
    parts.append("\nMy memory notes:\n" + ("\n".join(f"- {n['text']}" for n in reversed(mem)) or "(none yet)"))
    if s.get("operator_memory"):
        parts.append("\nResearch operator's rolling memory:\n" + s["operator_memory"][:1500])
    return "\n".join(parts)


def _first_turn(uid: str, thread_id: str, message: str, context: dict) -> dict:
    history = thread_messages(uid, thread_id, HISTORY_MESSAGES)
    lines = []
    for m in history:
        ev = "; ".join(e.get("summary", "") for e in (m.get("events") or [])[:6])
        lines.append(f"{'User' if m['role'] == 'user' else 'Brain'}: {m.get('text', '')[:1500]}" + (f"  [did: {ev}]" if ev else ""))
    text = ("Conversation so far:\n" + "\n".join(lines) + "\n\n") if lines else ""
    if context.get("experiment_id"):
        text += f"The user is currently looking at experiment {context['experiment_id']}.\n"
    if context.get("live"):
        text += "Live EEG snapshot from the app: " + json.dumps(context["live"], default=str)[:2000] + "\n"
    text += f"User's new message: {message}"
    return {"role": "user", "text": text}


def respond(user: dict, message: str, thread_id: str | None = None, context: dict | None = None) -> dict:
    uid = user["uid"]
    context = context or {}
    if thread_id:
        runner.owned("chat_threads", thread_id, uid)
    else:
        thread_id = latest_thread(uid) or new_thread(uid)
    if context.get("experiment_id"):
        runner.owned("experiments", context["experiment_id"], uid)
    first = _first_turn(uid, thread_id, message, context)
    _save_message(uid, thread_id, "user", message)
    turn = ChatTurn(user, message, context)
    if context.get("experiment_id"):
        turn._focus(context["experiment_id"])

    def dispatch(name, args):
        if name not in TOOL_NAMES:
            return {"error": f"unknown tool {name}"}, None
        try:
            return getattr(turn, name)(**args)
        except limits.RateLimited as exc:
            return {"denied": str(exc)}, None
        except KeyError as exc:
            return {"error": f"not found: {str(exc).strip(chr(39))}"}, None
        except (ValueError, PermissionError) as exc:
            return {"error": str(exc)[:600]}, None

    try:
        _, reply, _ = llm.run_tools(_system(uid), first, TOOLS, dispatch, max_steps=CHAT_MAX_STEPS)
        reply = reply.strip()
        if not reply:
            reply = ("I got so absorbed in the research that I ran out of steps before writing my answer. "
                     "Ask me again and I'll pick up where I left off" + (" — the jobs I started are in the sidebar." if turn.events else "."))
    except PermissionError:
        raise
    except Exception:
        log.exception("chat turn failed for %s", uid)
        reply = "Sorry — my language neurons misfired (the model provider is having trouble). Give me a moment and try again?"
        turn.mood = turn.mood or "sleepy"
    mood = turn.mood or "happy"
    focus = turn.focus or None
    _save_message(uid, thread_id, "brain", reply, turn.events, mood, focus)
    return {"thread_id": thread_id, "reply": reply, "mood": mood, "events": turn.events, "focus": focus}

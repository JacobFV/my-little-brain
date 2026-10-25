"""Provider-neutral tool-calling model layer with ordered failover (Gemini, OpenAI).

Conversations are kept in a neutral form, so a turn can be answered by any provider:

    {"role": "user",  "text": str, "images": [png bytes]}
    {"role": "model", "text": str, "calls": [{"id","name","args"}], "provider": str, "raw": provider-native turn}
    {"role": "tool",  "results": [{"id","name","result"}], "images": [png bytes]}

`AGENT_PROVIDERS` is an ordered chain, e.g.
    gemini:GEMINI_API_KEY,gemini:GEMINI_API_KEY_B@gemini-3.8-flash,openai:OPENAI_API_KEY
Each entry names a provider family, the *environment variable* holding its key (never the key
itself) and optionally a model. The router tries entries in order, skips ones that recently
failed with quota/rate/billing/outage errors, and reports which entry produced every turn.
"""
from __future__ import annotations

import base64
import json
import logging
import os
import threading
import time
from dataclasses import dataclass, field
from typing import Any

log = logging.getLogger("cortex2.llm")

GEMINI_DEFAULT_MODEL = "gemini-4-argon"
OPENAI_DEFAULT_MODEL = "gpt-6.1-sol"
DEFAULT_CHAIN = "gemini:GEMINI_API_KEY,openai:OPENAI_API_KEY"
COOLDOWN_SECONDS = {"quota": 900, "rate": 60, "auth": 3600, "unavailable": 45, "model": 3600}
# Gemini 3+ requires thought signatures on function-call parts; calls produced by another
# provider carry none, so they use the documented validator-skip sentinel.
FOREIGN_SIGNATURE = b"skip_thought_signature_validator"


class ProviderError(RuntimeError):
    def __init__(self, kind: str, message: str):
        super().__init__(message)
        self.kind = kind  # quota | rate | auth | unavailable | model | bad_request


def classify(exc: Exception) -> str:
    text = f"{type(exc).__name__} {exc}".lower()
    code = getattr(exc, "code", None) or getattr(exc, "status_code", None)
    if "resource_exhausted" in text or "quota" in text or "billing" in text or "insufficient_quota" in text:
        return "quota"
    if code == 429 or "rate limit" in text or "rate_limit" in text:
        return "rate"
    if code in (401, 403) or "permission" in text or "api key" in text or "unauthenticated" in text:
        return "auth"
    if code == 404 or "not found" in text and "model" in text or "model_not_found" in text:
        return "model"
    if code in (500, 502, 503, 504) or "unavailable" in text or "timeout" in text or "overloaded" in text or "connection" in text:
        return "unavailable"
    return "bad_request"


@dataclass
class Turn:
    text: str
    calls: list[dict]
    raw: Any
    provider: str
    response_id: str | None = None
    usage: dict = field(default_factory=dict)


@dataclass
class Tool:
    name: str
    description: str
    parameters: dict


# ---------------------------------------------------------------- Gemini

class GeminiBackend:
    family = "gemini"

    def __init__(self, key_env: str, model: str):
        self.key_env, self.model = key_env, model
        self.label = f"gemini/{model} ({key_env})"
        self._client = None

    def available(self) -> bool:
        return bool(os.environ.get(self.key_env))

    def client(self):
        if self._client is None:
            from google import genai
            from google.genai import types

            self._client = genai.Client(api_key=os.environ[self.key_env],
                                        http_options=types.HttpOptions(timeout=600_000))
        return self._client

    def _contents(self, history: list[dict]):
        from google.genai import types

        contents = []
        for m in history:
            if m["role"] == "user":
                parts = [types.Part.from_text(text=m.get("text") or " ")]
                parts += [types.Part.from_bytes(data=img, mime_type="image/png") for img in m.get("images", [])]
                contents.append(types.Content(role="user", parts=parts))
            elif m["role"] == "model":
                if m.get("raw") is not None and m.get("family") == "gemini":
                    contents.append(m["raw"])
                    continue
                parts = [types.Part.from_text(text=m["text"])] if m.get("text") else []
                for c in m.get("calls", []):
                    parts.append(types.Part(function_call=types.FunctionCall(name=c["name"], args=c["args"], id=c.get("id")),
                                            thought_signature=FOREIGN_SIGNATURE))
                contents.append(types.Content(role="model", parts=parts or [types.Part.from_text(text=" ")]))
            elif m["role"] == "tool":
                parts = [types.Part.from_function_response(name=r["name"], response={"result": r["result"]}) for r in m["results"]]
                if m.get("images"):
                    parts.append(types.Part.from_text(text="Rendered output of the tool call(s) above:"))
                    parts += [types.Part.from_bytes(data=img, mime_type="image/png") for img in m["images"]]
                contents.append(types.Content(role="user", parts=parts))
        return contents

    def complete(self, system: str, history: list[dict], tools: list[Tool], effort: str = "") -> Turn:
        from google.genai import types

        config = types.GenerateContentConfig(
            system_instruction=system,
            tools=[types.Tool(function_declarations=[types.FunctionDeclaration(
                name=t.name, description=t.description, parameters_json_schema=t.parameters) for t in tools])] if tools else None,
            automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
        )
        if effort:
            config.thinking_config = types.ThinkingConfig(thinking_level=effort)
        try:
            r = self.client().models.generate_content(model=self.model, contents=self._contents(history), config=config)
        except Exception as exc:
            raise ProviderError(classify(exc), f"{self.label}: {exc}") from exc
        if not r.candidates:
            reason = getattr(getattr(r, "prompt_feedback", None), "block_reason", None)
            raise ProviderError("bad_request", f"{self.label}: no candidates (block reason {reason})")
        content = r.candidates[0].content
        calls = [{"id": f.id or f"call_{i}", "name": f.name, "args": dict(f.args or {})} for i, f in enumerate(r.function_calls or [])]
        text = "".join(p.text for p in (content.parts or []) if getattr(p, "text", None) and not getattr(p, "thought", False))
        usage = r.usage_metadata.model_dump(exclude_none=True) if r.usage_metadata else {}
        return Turn(text, calls, content, self.label, getattr(r, "response_id", None), usage)


# ---------------------------------------------------------------- OpenAI (Responses API, stateless replay)

class OpenAIBackend:
    family = "openai"

    def __init__(self, key_env: str, model: str):
        self.key_env, self.model = key_env, model
        self.label = f"openai/{model} ({key_env})"
        self._client = None

    def available(self) -> bool:
        return bool(os.environ.get(self.key_env))

    def client(self):
        if self._client is None:
            from openai import OpenAI

            self._client = OpenAI(api_key=os.environ[self.key_env], timeout=600)
        return self._client

    @staticmethod
    def _image(img: bytes) -> dict:
        return {"type": "input_image", "image_url": "data:image/png;base64," + base64.b64encode(img).decode()}

    def _input(self, history: list[dict]) -> list:
        items: list = []
        for m in history:
            if m["role"] == "user":
                items.append({"role": "user", "content": [{"type": "input_text", "text": m.get("text") or " "}]
                              + [self._image(i) for i in m.get("images", [])]})
            elif m["role"] == "model":
                if m.get("raw") is not None and m.get("family") == "openai":
                    items.extend(m["raw"])
                    continue
                if m.get("text"):
                    items.append({"role": "assistant", "content": m["text"]})
                for c in m.get("calls", []):
                    items.append({"type": "function_call", "call_id": c["id"], "name": c["name"], "arguments": json.dumps(c["args"])})
            elif m["role"] == "tool":
                for r in m["results"]:
                    items.append({"type": "function_call_output", "call_id": r["id"], "output": json.dumps(r["result"], default=str)})
                if m.get("images"):
                    items.append({"role": "user", "content": [{"type": "input_text", "text": "Rendered output of the tool call(s) above:"}]
                                  + [self._image(i) for i in m["images"]]})
        return items

    def complete(self, system: str, history: list[dict], tools: list[Tool], effort: str = "") -> Turn:
        kwargs: dict[str, Any] = {"model": self.model, "instructions": system, "input": self._input(history), "store": False,
                                  "tools": [{"type": "function", "name": t.name, "description": t.description, "parameters": t.parameters}
                                            for t in tools]}
        if effort:
            kwargs["reasoning"] = {"effort": effort}
            kwargs["include"] = ["reasoning.encrypted_content"]
        try:
            r = self.client().responses.create(**kwargs)
        except Exception as exc:
            raise ProviderError(classify(exc), f"{self.label}: {exc}") from exc
        calls = [{"id": o.call_id, "name": o.name, "args": json.loads(o.arguments or "{}")}
                 for o in r.output if getattr(o, "type", None) == "function_call"]
        raw = [o.model_dump(exclude_none=True) for o in r.output]
        usage = r.usage.model_dump(exclude_none=True) if getattr(r, "usage", None) else {}
        return Turn(getattr(r, "output_text", "") or "", calls, raw, self.label, r.id, usage)


FAMILIES = {"gemini": (GeminiBackend, "GEMINI_MODEL", GEMINI_DEFAULT_MODEL),
            "openai": (OpenAIBackend, "OPENAI_MODEL", OPENAI_DEFAULT_MODEL)}


# ---------------------------------------------------------------- router

class Router:
    def __init__(self, backends: list):
        self.backends = backends
        self.cooldown: dict[str, tuple[float, str]] = {}
        self.lock = threading.Lock()

    def configured(self) -> list:
        return [b for b in self.backends if b.available()]

    def status(self) -> list[dict]:
        now = time.time()
        return [{"provider": b.label, "family": b.family, "model": b.model, "configured": b.available(),
                 "cooling_down": (self.cooldown[b.label][1] if b.label in self.cooldown and self.cooldown[b.label][0] > now else None)}
                for b in self.backends]

    def primary(self) -> str | None:
        c = self.configured()
        return c[0].model if c else None

    def complete(self, system: str, history: list[dict], tools: list[Tool], effort: str = "") -> Turn:
        candidates = self.configured()
        if not candidates:
            raise PermissionError("no model provider configured: set GEMINI_API_KEY (or another AGENT_PROVIDERS key)")
        now = time.time()
        ready = [b for b in candidates if self.cooldown.get(b.label, (0, ""))[0] <= now]
        order = ready + [b for b in candidates if b not in ready]   # if all are cooling down, still try
        errors = []
        for b in order:
            try:
                turn = b.complete(system, history, tools, effort)
                with self.lock:
                    self.cooldown.pop(b.label, None)
                turn.family = b.family  # type: ignore[attr-defined]
                return turn
            except ProviderError as exc:
                errors.append(f"[{exc.kind}] {exc}"[:400])
                log.warning("provider %s failed (%s): %s", b.label, exc.kind, str(exc)[:300])
                if exc.kind == "bad_request":
                    break          # the request itself is wrong; another provider will not fix it
                with self.lock:
                    self.cooldown[b.label] = (time.time() + COOLDOWN_SECONDS.get(exc.kind, 60), exc.kind)
        raise RuntimeError("all model providers failed:\n" + "\n".join(errors))


def parse_chain(spec: str | None = None) -> list:
    spec = spec if spec is not None else os.environ.get("AGENT_PROVIDERS") or DEFAULT_CHAIN
    out = []
    for raw in spec.split(","):
        raw = raw.strip()
        if not raw:
            continue
        family, _, rest = raw.partition(":")
        key_env, _, model = rest.partition("@")
        if family not in FAMILIES or not key_env:
            raise ValueError(f"bad AGENT_PROVIDERS entry {raw!r} (expected family:KEY_ENV[@model])")
        cls, model_env, default = FAMILIES[family]
        out.append(cls(key_env, model or os.environ.get(model_env) or default))
    return out


_router: Router | None = None


def router() -> Router:
    global _router
    if _router is None:
        _router = Router(parse_chain())
    return _router


def set_router(r: Router | None) -> None:
    """Tests inject a scripted router."""
    global _router
    _router = r


def run_tools(system: str, first: dict, tools: list[Tool], dispatch, *, max_steps: int = 18, effort: str = "",
              on_step=None, stop=lambda: False) -> tuple[list[dict], str, list[dict]]:
    """Model ↔ tool loop. dispatch(name, args) → (json-able result, optional png bytes).

    Returns (provenance per turn, final text, neutral history).
    """
    history: list[dict] = [first]
    provenance: list[dict] = []
    final = ""
    for _ in range(max_steps + 1):
        turn = router().complete(system, history, tools, effort)
        provenance.append({"provider": turn.provider, "response_id": turn.response_id, "usage": turn.usage, "time": time.time()})
        history.append({"role": "model", "text": turn.text, "calls": turn.calls, "raw": turn.raw,
                        "family": getattr(turn, "family", None), "provider": turn.provider})
        final = turn.text or final
        if not turn.calls:
            break
        results, images = [], []
        for call in turn.calls:
            try:
                result, png = dispatch(call["name"], call["args"])
            except Exception as exc:
                log.exception("tool %s failed", call["name"])
                result, png = {"error": f"{type(exc).__name__}: {exc}"[:1500]}, None
            if on_step:
                on_step(call["name"], call["args"], result)
            encoded = json.dumps(result, default=str)
            if len(encoded) > 60_000:
                result = {"truncated": True, "head": encoded[:60_000]}
            else:
                result = json.loads(encoded)
            results.append({"id": call["id"], "name": call["name"], "result": result})
            if png:
                images.append(png)
        history.append({"role": "tool", "results": results, "images": images})
        if stop():
            break
    return provenance, final, history

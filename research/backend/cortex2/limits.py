"""Per-user rate limits and quotas (cost-abuse protection), backed by the store.

Each action has a fixed window and a maximum; counters live in the `quotas` collection keyed
`<uid>:<action>:<window-start>` and are incremented transactionally, so limits hold across
Cloud Run instances. Every limit is overridable with an env var `LIMIT_<ACTION>` (an integer;
0 disables the action, a negative value removes the limit).

Physical-QPU submissions are per-account: everyone gets LIMIT_HARDWARE_JOB (default 0/day) unless
`HARDWARE_QUOTAS` (comma-separated `email:n`) grants more. Users request increases from HARDWARE_CONTACT.
"""
from __future__ import annotations

import os
import time
from dataclasses import dataclass
from datetime import datetime, timezone

from .store import now, store

DEFAULTS = {
    #  action           (window seconds, max)
    "job":              (3600, 120),     # sampling jobs created by the user
    "hardware_job":     (86400, 0),      # physical QPU submissions (IBM / IonQ / qBraid); see HARDWARE_QUOTAS
    "agent_iteration":  (86400, 40),     # agent design iterations (model calls)
    "agent_message":    (3600, 60),      # chat/triage messages (model calls)
    "preview":          (60, 30),        # synchronous circuit compiles (CPU heavy)
    "experiment":       (86400, 200),
    "ingest_token":     (86400, 30),
    "recording":        (86400, 60),
    "snapshot":         (60, 20),
    "chat_message":     (3600, 60),      # brain chat turns (each runs up to ~8 model/tool steps)
    "profile_doc":      (86400, 50),     # "about me" document uploads
}


class RateLimited(Exception):
    def __init__(self, action: str, limit: int, window: int, retry_after: int):
        self.action, self.limit, self.window, self.retry_after = action, limit, window, retry_after
        human = f"{window // 3600} h" if window >= 3600 else f"{window // 60} min" if window >= 60 else f"{window} s"
        super().__init__(f"rate limit: at most {limit} {action.replace('_', ' ')}s per {human}; retry in {retry_after} s")


@dataclass
class Limit:
    window: int
    maximum: int


def limit_for(action: str) -> Limit:
    window, maximum = DEFAULTS[action]
    raw = os.environ.get(f"LIMIT_{action.upper()}")
    if raw not in (None, ""):
        maximum = int(raw)
    return Limit(window, maximum)


def consume(uid: str, action: str, amount: int = 1, maximum: int | None = None) -> int:
    """Count one use of `action` by `uid`; raises RateLimited if over the limit. Returns uses so far."""
    lim = limit_for(action)
    if maximum is not None:
        lim.maximum = maximum
    if lim.maximum < 0:
        return 0
    t = int(time.time())
    start = t - t % lim.window
    key = f"{uid}:{action}:{start}"
    retry = start + lim.window - t
    if lim.maximum == 0:
        raise RateLimited(action, 0, lim.window, retry)
    result = {"n": 0}

    def fn(cur):
        used = int((cur or {}).get("count", 0))
        if used + amount > lim.maximum:
            return None
        result["n"] = used + amount
        return {"owner": uid, "action": action, "count": used + amount, "window_start": start,
                "updated_at": now(),
                # Firestore TTL policy on `expire_at` (a timestamp) garbage-collects old windows
                "expire_at": datetime.fromtimestamp(start + 2 * lim.window, tz=timezone.utc)}

    if store().transact("quotas", key, fn) is None:
        raise RateLimited(action, lim.maximum, lim.window, retry)
    return result["n"]


HARDWARE_CONTACT = os.environ.get("HARDWARE_CONTACT") or "jacobfv123@gmail.com"


class HardwareQuota(RateLimited):
    def __init__(self, limit: int, retry_after: int):
        super().__init__("hardware_job", limit, 86400, retry_after)
        self.args = (f"physical-QPU quota reached ({limit}/day for this account); "
                     f"email {HARDWARE_CONTACT} to request a higher limit",)


def hardware_quota(email: str | None) -> int:
    """Daily physical-QPU submissions allowed for this account."""
    for item in (os.environ.get("HARDWARE_QUOTAS") or f"{HARDWARE_CONTACT}:4").split(","):
        addr, _, n = item.strip().rpartition(":")
        if addr and addr.lower() == (email or "").lower():
            return int(n)
    return limit_for("hardware_job").maximum


def hardware_usage(uid: str, email: str | None) -> dict:
    window = DEFAULTS["hardware_job"][0]
    t = int(time.time())
    start = t - t % window
    used = int((store().get("quotas", f"{uid}:hardware_job:{start}") or {}).get("count", 0))
    return {"used": used, "limit": hardware_quota(email), "window_seconds": window,
            "resets_in": start + window - t, "contact": HARDWARE_CONTACT}


def consume_hardware(uid: str, email: str | None) -> int:
    try:
        return consume(uid, "hardware_job", maximum=hardware_quota(email))
    except RateLimited as exc:
        raise HardwareQuota(exc.limit, exc.retry_after) from None

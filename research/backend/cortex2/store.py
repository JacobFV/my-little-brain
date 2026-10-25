"""Persistence: Firestore + Cloud Storage in production, a JSON file + directory locally.

Both backends implement the same small interface so the API and worker code never branch
on environment. Queries filter on `owner` (single-field index) and sort in Python, so no
composite Firestore indexes are required.

Firestore constraints handled here, transparently for callers:
  * an array may not directly contain an array → nested arrays are wrapped on write and
    unwrapped on read (`encode` / `decode`);
  * documents are at most 1 MiB → writes are size-checked and fail with `DocumentTooLarge`;
  * numpy scalars/arrays are coerced to plain Python values.
`LocalStore(strict=True)` (or CORTEX_STRICT_STORE=1) applies the same checks so tests catch
production-only failures.
"""
from __future__ import annotations

import json
import os
import threading
import uuid
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Callable

MAX_DOC_BYTES = 1_000_000
NESTED = "_nested_list"


class DocumentTooLarge(ValueError):
    pass


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def new_id() -> str:
    return uuid.uuid4().hex[:20]


def encode(value: Any, _in_array: bool = False) -> Any:
    """Make a JSON-like value Firestore-safe: wrap arrays nested in arrays, coerce numpy values."""
    if isinstance(value, dict):
        return {str(k): encode(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        items = [encode(v, _in_array=True) for v in value]
        return {NESTED: items} if _in_array else items
    if isinstance(value, (str, bytes, bool, int, float, datetime, date)) or value is None:
        return value
    if hasattr(value, "tolist"):          # numpy array or scalar
        return encode(value.tolist(), _in_array)
    if hasattr(value, "item"):
        return value.item()
    return value


def decode(value: Any) -> Any:
    if isinstance(value, dict):
        if set(value) == {NESTED}:
            return [decode(v) for v in value[NESTED]]
        return {k: decode(v) for k, v in value.items()}
    if isinstance(value, list):
        return [decode(v) for v in value]
    return value


def _json_default(o):
    if isinstance(o, (datetime, date)):
        return o.isoformat()
    if hasattr(o, "tolist"):
        return o.tolist()
    if hasattr(o, "item"):
        return o.item()
    raise TypeError(f"not serializable: {type(o).__name__}")


def doc_size(encoded: dict) -> int:
    """Approximate Firestore storage size (compact JSON length is a close upper bound)."""
    return len(json.dumps(encoded, default=_json_default, separators=(",", ":")))


def check_document(coll: str, encoded: dict) -> None:
    def walk(v, in_array=False):
        if isinstance(v, list):
            if in_array:
                raise ValueError(f"{coll}: array nested in array (Firestore rejects this)")
            for x in v:
                walk(x, True)
        elif isinstance(v, dict):
            for x in v.values():
                walk(x)
    walk(encoded)
    size = doc_size(encoded)
    if size > MAX_DOC_BYTES:
        raise DocumentTooLarge(f"{coll} document would be {size} bytes (Firestore limit is 1 MiB)")


class Store:
    def create(self, coll: str, data: dict, doc_id: str | None = None) -> dict: ...
    def get(self, coll: str, doc_id: str) -> dict | None: ...
    def set(self, coll: str, doc_id: str, data: dict) -> None: ...
    def update(self, coll: str, doc_id: str, patch: dict) -> None: ...
    def delete(self, coll: str, doc_id: str) -> None: ...
    def where(self, coll: str, field: str, value: Any, limit: int = 300) -> list[dict]: ...
    def transact(self, coll: str, doc_id: str, fn: Callable[[dict | None], dict | None]) -> dict | None:
        """Atomically read-modify-write. `fn` returns the patch to apply (or None to abort)."""
        ...

    def query(self, coll: str, owner: str, order: str = "created_at", limit: int = 100, **eq) -> list[dict]:
        rows = self.where(coll, "owner", owner, limit=1000)
        rows = [r for r in rows if all(r.get(k) == v for k, v in eq.items())]
        rows.sort(key=lambda r: str(r.get(order) or ""), reverse=True)
        return rows[:limit]


class LocalStore(Store):
    def __init__(self, path: Path, strict: bool | None = None):
        self.path = path
        self.strict = os.environ.get("CORTEX_STRICT_STORE") == "1" if strict is None else strict
        self.lock = threading.RLock()
        self.data: dict[str, dict[str, dict]] = {}
        if path.exists():
            try:
                self.data = json.loads(path.read_text())
            except ValueError:
                path.rename(path.with_suffix(".corrupt.json"))

    def _flush(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.data, default=_json_default))
        tmp.replace(self.path)

    def _clean(self, coll: str, data: dict) -> dict:
        if self.strict:
            check_document(coll, encode(data))
        return json.loads(json.dumps(data, default=_json_default))

    def create(self, coll, data, doc_id=None):
        with self.lock:
            doc_id = doc_id or new_id()
            c = self.data.setdefault(coll, {})
            if doc_id in c:
                raise KeyError(f"{coll}/{doc_id} exists")
            c[doc_id] = self._clean(coll, data)
            self._flush()
            return {**c[doc_id], "id": doc_id}

    def get(self, coll, doc_id):
        with self.lock:
            d = self.data.get(coll, {}).get(doc_id)
            return {**json.loads(json.dumps(d)), "id": doc_id} if d is not None else None

    def set(self, coll, doc_id, data):
        with self.lock:
            self.data.setdefault(coll, {})[doc_id] = self._clean(coll, data)
            self._flush()

    def update(self, coll, doc_id, patch):
        with self.lock:
            cur = self.data.setdefault(coll, {}).get(doc_id, {})
            self.data[coll][doc_id] = self._clean(coll, {**cur, **patch})
            self._flush()

    def delete(self, coll, doc_id):
        with self.lock:
            self.data.get(coll, {}).pop(doc_id, None)
            self._flush()

    def where(self, coll, field, value, limit=300):
        with self.lock:
            rows = [{**v, "id": k} for k, v in self.data.get(coll, {}).items() if v.get(field) == value]
            return json.loads(json.dumps(rows[:limit]))

    def transact(self, coll, doc_id, fn):
        with self.lock:
            cur = self.get(coll, doc_id)
            patch = fn(cur)
            if patch is None:
                return None
            if cur is None:
                self.set(coll, doc_id, patch)
            else:
                self.update(coll, doc_id, patch)
            return self.get(coll, doc_id)


class FirestoreStore(Store):
    """`update` replaces whole top-level fields (same semantics as LocalStore), never deep-merging
    stale nested keys into maps such as `spec` or `evaluation`."""

    def __init__(self):
        from google.cloud import firestore

        self.fs = firestore
        self.db = firestore.Client(project=os.environ.get("GOOGLE_CLOUD_PROJECT") or None)

    def _ref(self, coll, doc_id):
        return self.db.collection(coll).document(doc_id)

    @staticmethod
    def _out(snap) -> dict:
        return {**decode(snap.to_dict() or {}), "id": snap.id}

    @staticmethod
    def _in(coll, data) -> dict:
        enc = encode(data)
        check_document(coll, enc)
        return enc

    def create(self, coll, data, doc_id=None):
        ref = self._ref(coll, doc_id) if doc_id else self.db.collection(coll).document()
        ref.create(self._in(coll, data))
        return {**data, "id": ref.id}

    def get(self, coll, doc_id):
        snap = self._ref(coll, doc_id).get()
        return self._out(snap) if snap.exists else None

    def set(self, coll, doc_id, data):
        self._ref(coll, doc_id).set(self._in(coll, data))

    def update(self, coll, doc_id, patch):
        enc = encode(patch)
        check_document(coll, enc)
        self._ref(coll, doc_id).set(enc, merge=list(enc.keys()))

    def delete(self, coll, doc_id):
        self._ref(coll, doc_id).delete()

    def where(self, coll, field, value, limit=300):
        from google.cloud.firestore_v1.base_query import FieldFilter

        docs = self.db.collection(coll).where(filter=FieldFilter(field, "==", value)).limit(limit).stream()
        return [self._out(d) for d in docs]

    def transact(self, coll, doc_id, fn):
        ref = self._ref(coll, doc_id)

        @self.fs.transactional
        def run(tx):
            snap = ref.get(transaction=tx)
            cur = self._out(snap) if snap.exists else None
            patch = fn(cur)
            if patch is None:
                return False
            enc = encode(patch)
            if snap.exists:
                tx.update(ref, enc)
            else:
                tx.set(ref, enc)
            return True

        return self.get(coll, doc_id) if run(self.db.transaction()) else None


class Artifacts:
    """PNG/JSON artifacts. Paths are always `<uid>/...` so reads are owner-scoped."""

    def __init__(self):
        self.bucket_name = os.environ.get("ARTIFACT_BUCKET", "")
        self.local = Path(os.environ.get("CORTEX_DATA_DIR", Path(__file__).resolve().parents[2] / ".data")) / "artifacts"
        self._bucket = None

    @staticmethod
    def safe(path: str) -> bool:
        """Relative, slash-separated, no empty/dot segments, no backslashes or NULs."""
        if not path or path.startswith("/") or "\\" in path or "\x00" in path:
            return False
        return all(p not in ("", ".", "..") for p in path.split("/"))

    @property
    def bucket(self):
        if self._bucket is None and self.bucket_name and on_gcp():
            from google.cloud import storage

            self._bucket = storage.Client().bucket(self.bucket_name)
        return self._bucket

    def put(self, path: str, data: bytes, content_type: str = "image/png") -> str:
        if not self.safe(path):
            raise ValueError(f"unsafe artifact path {path!r}")
        if self.bucket is not None:
            self.bucket.blob(path).upload_from_string(data, content_type=content_type)
        else:
            p = self.local / path
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(data)
        return path

    def get(self, path: str) -> bytes | None:
        if not self.safe(path):
            return None
        if self.bucket is not None:
            blob = self.bucket.blob(path)
            return blob.download_as_bytes() if blob.exists() else None
        p = self.local / path
        return p.read_bytes() if p.exists() else None

    def put_json(self, path: str, obj: Any) -> str:
        import gzip

        return self.put(path, gzip.compress(json.dumps(obj, default=_json_default).encode()), "application/gzip")

    def get_json(self, path: str) -> Any:
        import gzip

        raw = self.get(path)
        return None if raw is None else json.loads(gzip.decompress(raw))


def on_gcp() -> bool:
    return bool(os.environ.get("K_SERVICE"))


_store: Store | None = None
_artifacts: Artifacts | None = None


def store() -> Store:
    global _store
    if _store is None:
        if on_gcp() or os.environ.get("CORTEX_STORE") == "firestore":
            _store = FirestoreStore()
        else:
            root = Path(os.environ.get("CORTEX_DATA_DIR", Path(__file__).resolve().parents[2] / ".data"))
            _store = LocalStore(root / "store.json")
    return _store


def artifacts() -> Artifacts:
    global _artifacts
    if _artifacts is None:
        _artifacts = Artifacts()
    return _artifacts


def set_store(s: Store) -> None:
    """Tests inject an isolated store."""
    global _store
    _store = s

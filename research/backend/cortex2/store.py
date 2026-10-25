"""Persistence: Firestore + Cloud Storage in production, a JSON file + directory locally.

Both backends implement the same small interface so the API and worker code never branch
on environment. Queries filter on `owner` (single-field index) and sort in Python, so no
composite Firestore indexes are required.
"""
from __future__ import annotations

import json
import os
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_id() -> str:
    return uuid.uuid4().hex[:20]


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
        rows.sort(key=lambda r: r.get(order) or "", reverse=True)
        return rows[:limit]


class LocalStore(Store):
    def __init__(self, path: Path):
        self.path = path
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
        tmp.write_text(json.dumps(self.data))
        tmp.replace(self.path)

    def create(self, coll, data, doc_id=None):
        with self.lock:
            doc_id = doc_id or new_id()
            c = self.data.setdefault(coll, {})
            if doc_id in c:
                raise KeyError(f"{coll}/{doc_id} exists")
            c[doc_id] = json.loads(json.dumps(data))
            self._flush()
            return {**c[doc_id], "id": doc_id}

    def get(self, coll, doc_id):
        with self.lock:
            d = self.data.get(coll, {}).get(doc_id)
            return {**json.loads(json.dumps(d)), "id": doc_id} if d is not None else None

    def set(self, coll, doc_id, data):
        with self.lock:
            self.data.setdefault(coll, {})[doc_id] = json.loads(json.dumps(data))
            self._flush()

    def update(self, coll, doc_id, patch):
        with self.lock:
            d = self.data.setdefault(coll, {}).setdefault(doc_id, {})
            d.update(json.loads(json.dumps(patch)))
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
    def __init__(self):
        from google.cloud import firestore

        self.fs = firestore
        self.db = firestore.Client(project=os.environ.get("GOOGLE_CLOUD_PROJECT") or None)

    def _ref(self, coll, doc_id):
        return self.db.collection(coll).document(doc_id)

    def create(self, coll, data, doc_id=None):
        ref = self._ref(coll, doc_id) if doc_id else self.db.collection(coll).document()
        ref.create(data)
        return {**data, "id": ref.id}

    def get(self, coll, doc_id):
        snap = self._ref(coll, doc_id).get()
        return {**snap.to_dict(), "id": snap.id} if snap.exists else None

    def set(self, coll, doc_id, data):
        self._ref(coll, doc_id).set(data)

    def update(self, coll, doc_id, patch):
        self._ref(coll, doc_id).set(patch, merge=True)

    def delete(self, coll, doc_id):
        self._ref(coll, doc_id).delete()

    def where(self, coll, field, value, limit=300):
        from google.cloud.firestore_v1.base_query import FieldFilter

        docs = self.db.collection(coll).where(filter=FieldFilter(field, "==", value)).limit(limit).stream()
        return [{**d.to_dict(), "id": d.id} for d in docs]

    def transact(self, coll, doc_id, fn):
        ref = self._ref(coll, doc_id)

        @self.fs.transactional
        def run(tx):
            snap = ref.get(transaction=tx)
            cur = {**snap.to_dict(), "id": snap.id} if snap.exists else None
            patch = fn(cur)
            if patch is None:
                return False
            if snap.exists:
                tx.update(ref, patch)
            else:
                tx.set(ref, patch)
            return True

        return self.get(coll, doc_id) if run(self.db.transaction()) else None


class Artifacts:
    """PNG/JSON artifacts. Paths are always `<uid>/...` so reads are owner-scoped."""

    def __init__(self):
        self.bucket_name = os.environ.get("ARTIFACT_BUCKET", "")
        self.local = Path(os.environ.get("CORTEX_DATA_DIR", Path(__file__).resolve().parents[2] / ".data")) / "artifacts"
        self._bucket = None

    @property
    def bucket(self):
        if self._bucket is None and self.bucket_name and on_gcp():
            from google.cloud import storage

            self._bucket = storage.Client().bucket(self.bucket_name)
        return self._bucket

    def put(self, path: str, data: bytes, content_type: str = "image/png") -> str:
        if self.bucket is not None:
            self.bucket.blob(path).upload_from_string(data, content_type=content_type)
        else:
            p = self.local / path
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(data)
        return path

    def get(self, path: str) -> bytes | None:
        if ".." in path:
            return None
        if self.bucket is not None:
            blob = self.bucket.blob(path)
            return blob.download_as_bytes() if blob.exists() else None
        p = self.local / path
        return p.read_bytes() if p.exists() else None


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

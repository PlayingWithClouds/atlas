"""Global training pool shared across all sessions.

Every label from every source (directory, gallery, video) feeds one pool, so the
classifier keeps learning as you switch sources instead of restarting per source.
All embeddings share the same DINOv2 space, so pooling is valid as long as the
embedding model matches.

Identity is the image ref (file path or URL); re-labeling the same image upserts.
"""

import json
import os
import threading

import numpy as np

def _cache_root() -> str:
    """Where pools live: inside the workspace when there is one, so two workspaces
    never share vectors, else the shared per-user cache this used to be."""
    workspace = os.environ.get("ATLAS_WORKSPACE")
    if workspace:
        return os.path.join(workspace, "cache")
    return os.path.expanduser("~/.cache/atlas")


CACHE_ROOT = _cache_root()
GLOBAL_DIR = os.path.join(CACHE_ROOT, "global")


class GlobalTrainSet:
    def __init__(self, model_name: str, dim: int, dir: str = GLOBAL_DIR):
        self.model_name = model_name
        self.dim = dim
        self.dir = dir
        self.lock = threading.Lock()

        self.refs: list[str] = []
        self.labels: list[list[str]] = []
        self.vectors = np.zeros((0, dim), dtype=np.float32)
        self.index_by_ref: dict[str, int] = {}

        os.makedirs(self.dir, exist_ok=True)
        self._load()

    def _meta_path(self) -> str:
        return os.path.join(self.dir, "meta.json")

    def _data_path(self) -> str:
        return os.path.join(self.dir, "trainset.npz")

    def _load(self) -> None:
        meta_path = self._meta_path()
        # A pool built with a different embedding model is incompatible; start fresh.
        if os.path.exists(meta_path):
            with open(meta_path) as handle:
                meta = json.load(handle)
            if meta.get("model_name") != self.model_name or meta.get("dim") != self.dim:
                return

        data_path = self._data_path()
        if not os.path.exists(data_path):
            return
        data = np.load(data_path, allow_pickle=True)
        refs = list(data["refs"])
        labels = [list(entry) for entry in data["labels"]]
        vectors = data["vectors"].astype(np.float32)

        # A pool interrupted between appending a row and writing its vector comes back
        # with more refs than vectors. Every reader indexes vectors by a ref's position,
        # so the extra rows are not merely useless — they raise IndexError on whichever
        # call happens to touch the last ref. Trim to the length all three agree on.
        usable = min(len(refs), len(labels), len(vectors))
        if usable != len(refs):
            print(f"pool {self.dir}: {len(refs)} refs but {len(vectors)} vectors — "
                  f"keeping the first {usable}")
        self.refs = refs[:usable]
        self.labels = labels[:usable]
        self.vectors = vectors[:usable]
        self.index_by_ref = {ref: position for position, ref in enumerate(self.refs)}

    def _save(self) -> None:
        with open(self._meta_path(), "w") as handle:
            json.dump({"model_name": self.model_name, "dim": self.dim}, handle)
        np.savez(
            self._data_path(),
            refs=np.array(self.refs, dtype=object),
            labels=np.array(self.labels, dtype=object),
            vectors=self.vectors,
        )

    def upsert(self, ref: str, vector: np.ndarray, labels: list[str]) -> None:
        with self.lock:
            existing = self.index_by_ref.get(ref)
            if existing is not None:
                self.labels[existing] = list(labels)
                self.vectors[existing] = vector
            else:
                self.index_by_ref[ref] = len(self.refs)
                self.refs.append(ref)
                self.labels.append(list(labels))
                self.vectors = np.vstack([self.vectors, vector[None, :]])
            self._save()

    def upsert_many(self, entries: list[tuple[str, np.ndarray, list[str]]]) -> None:
        """Bulk upsert with a single save — used to backfill a source's existing labels."""
        if not entries:
            return
        with self.lock:
            for ref, vector, labels in entries:
                existing = self.index_by_ref.get(ref)
                if existing is not None:
                    self.labels[existing] = list(labels)
                    self.vectors[existing] = vector
                else:
                    self.index_by_ref[ref] = len(self.refs)
                    self.refs.append(ref)
                    self.labels.append(list(labels))
                    self.vectors = np.vstack([self.vectors, vector[None, :]])
            self._save()

    def remove(self, refs: list[str]) -> int:
        """Drop rows by ref and return how many went. Identity is the ref, so an entity
        whose ref changes (a trimmed temporal span) must have its old row removed —
        otherwise it stays a training example for a range that no longer exists."""
        if not refs:
            return 0
        with self.lock:
            doomed = {ref for ref in refs if ref in self.index_by_ref}
            if not doomed:
                return 0
            keep = [position for position, ref in enumerate(self.refs) if ref not in doomed]
            self.refs = [self.refs[position] for position in keep]
            self.labels = [self.labels[position] for position in keep]
            self.vectors = self.vectors[keep] if keep else np.zeros((0, self.dim), dtype=np.float32)
            self.index_by_ref = {ref: position for position, ref in enumerate(self.refs)}
            self._save()
            return len(doomed)

    def matrix(self, classes: list[str]) -> tuple[np.ndarray, np.ndarray]:
        """Build (X, Y) over the whole pool for a given class list."""
        with self.lock:
            if not self.refs:
                return (
                    np.zeros((0, self.dim), dtype=np.float32),
                    np.zeros((0, len(classes)), dtype=np.float32),
                )
            class_index = {name: position for position, name in enumerate(classes)}
            Y = np.zeros((len(self.refs), len(classes)), dtype=np.float32)
            for row, labels in enumerate(self.labels):
                for name in labels:
                    if name in class_index:
                        Y[row, class_index[name]] = 1.0
            return self.vectors.copy(), Y

    def count(self) -> int:
        return len(self.refs)


class VectorCache:
    """Persisted embeddings for refs that carry no label yet.

    The pool only holds labeled rows, but the backend marks an entity `embedded` in its
    own database the moment the plugin reports a vector for it. Keeping those vectors in
    memory only made that flag a lie across a restart: the entity stayed "embedded" while
    every predict/rank silently re-embedded it — minutes of ffmpeg for a video session.

    This is a cache, not a record: it is capped, evicts oldest-first, and saves on a
    debounce so a batch of embeds costs one write instead of one per chunk.
    """

    def __init__(self, model_name: str, dim: int, dir: str,
                 capacity: int = 20000, flush_seconds: float = 5.0):
        self.model_name = model_name
        self.dim = dim
        self.dir = dir
        self.capacity = capacity
        self.flush_seconds = flush_seconds
        self.lock = threading.Lock()
        self.vectors: dict[str, np.ndarray] = {}
        self._flush_timer: threading.Timer | None = None

        os.makedirs(self.dir, exist_ok=True)
        self._load()

    def _path(self) -> str:
        return os.path.join(self.dir, "vectors.npz")

    def _load(self) -> None:
        path = self._path()
        if not os.path.exists(path):
            return
        try:
            data = np.load(path, allow_pickle=True)
        except Exception as error:
            print(f"vector cache load: {error}")
            return
        # A cache written by a different backbone is meaningless in this vector space.
        if "model_name" not in data.files or str(data["model_name"]) != self.model_name:
            return
        matrix = data["vectors"].astype(np.float32)
        if matrix.shape[1:] != (self.dim,):
            return
        self.vectors = {ref: matrix[row] for row, ref in enumerate(data["refs"])}

    def get(self, ref: str):
        return self.vectors.get(ref)

    def put(self, entries: dict) -> None:
        if not entries:
            return
        with self.lock:
            self.vectors.update(entries)
            self._evict()
        self._schedule_flush()

    def drop(self, refs) -> None:
        with self.lock:
            removed = [ref for ref in refs if self.vectors.pop(ref, None) is not None]
        if removed:
            self._schedule_flush()

    # Dicts keep insertion order, so the front of the dict is the oldest entry.
    def _evict(self) -> None:
        overflow = len(self.vectors) - self.capacity
        if overflow <= 0:
            return
        for ref in list(self.vectors)[:overflow]:
            del self.vectors[ref]

    def _schedule_flush(self) -> None:
        with self.lock:
            if self._flush_timer is not None:
                return
            self._flush_timer = threading.Timer(self.flush_seconds, self.flush)
            self._flush_timer.daemon = True
            self._flush_timer.start()

    def flush(self) -> None:
        with self.lock:
            self._flush_timer = None
            refs = list(self.vectors)
            if refs:
                matrix = np.stack([self.vectors[ref] for ref in refs]).astype(np.float32)
            else:
                matrix = np.zeros((0, self.dim), dtype=np.float32)
        try:
            np.savez(self._path(), model_name=self.model_name,
                     refs=np.array(refs, dtype=object), vectors=matrix)
        except Exception as error:
            print(f"vector cache save: {error}")

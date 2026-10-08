"""Per-project vector storage under `<cache>/<encoder id>/<project id>/`.

`TrainPool` holds labeled rows; `VectorCache` holds embeddings of unlabeled refs so the
"embedded" flag survives a restart. Both are bound to one encoder: a directory written
by an encoder with another id or dimension is treated as empty.
"""

import json
import os
import threading

import numpy as np

from atlas_ml.log import log


def pool_directory(cache_root: str, encoder_id: str, project_id: str) -> str:
    return os.path.join(cache_root, encoder_id, project_id)


def empty_matrix(dim: int) -> np.ndarray:
    return np.zeros((0, dim), dtype=np.float32)


class TrainPool:
    def __init__(self, encoder_id: str, dim: int, directory: str):
        self.encoder_id = encoder_id
        self.dim = dim
        self.directory = directory
        self.lock = threading.Lock()

        self.refs: list[str] = []
        self.labels: list[list[str]] = []
        self.vectors = empty_matrix(dim)
        self.index_by_ref: dict[str, int] = {}

        os.makedirs(self.directory, exist_ok=True)
        self.load()

    def meta_path(self) -> str:
        return os.path.join(self.directory, "meta.json")

    def data_path(self) -> str:
        return os.path.join(self.directory, "trainset.npz")

    def meta_matches(self) -> bool:
        if not os.path.exists(self.meta_path()):
            return True
        with open(self.meta_path()) as handle:
            meta = json.load(handle)
        return meta.get("encoder_id") == self.encoder_id and meta.get("dim") == self.dim

    def load(self) -> None:
        # A pool built by a different encoder lives in another vector space; start fresh.
        if not self.meta_matches():
            return
        if not os.path.exists(self.data_path()):
            return
        data = np.load(self.data_path(), allow_pickle=True)
        refs = list(data["refs"])
        labels = [list(entry) for entry in data["labels"]]
        vectors = data["vectors"].astype(np.float32)
        if vectors.ndim != 2 or vectors.shape[1] != self.dim:
            return

        # An interrupted write can leave more refs than vectors; readers index vectors
        # by a ref's position, so trim to the length all three agree on.
        usable = min(len(refs), len(labels), len(vectors))
        if usable != len(refs):
            log(f"pool {self.directory}: {len(refs)} refs but {len(vectors)} vectors, "
                f"keeping the first {usable}")
        self.refs = refs[:usable]
        self.labels = labels[:usable]
        self.vectors = vectors[:usable]
        self.reindex()

    def reindex(self) -> None:
        self.index_by_ref = {ref: position for position, ref in enumerate(self.refs)}

    def save(self) -> None:
        with open(self.meta_path(), "w") as handle:
            json.dump({"encoder_id": self.encoder_id, "dim": self.dim}, handle)
        np.savez(
            self.data_path(),
            refs=np.array(self.refs, dtype=object),
            labels=np.array(self.labels, dtype=object),
            vectors=self.vectors,
        )

    def put_row(self, ref: str, vector: np.ndarray, labels: list[str]) -> None:
        existing = self.index_by_ref.get(ref)
        if existing is not None:
            self.labels[existing] = list(labels)
            self.vectors[existing] = vector
            return
        self.index_by_ref[ref] = len(self.refs)
        self.refs.append(ref)
        self.labels.append(list(labels))
        self.vectors = np.vstack([self.vectors, vector[None, :]])

    def upsert(self, ref: str, vector: np.ndarray, labels: list[str]) -> None:
        self.upsert_many([(ref, vector, labels)])

    def upsert_many(self, entries: list[tuple[str, np.ndarray, list[str]]]) -> None:
        """Bulk upsert with a single save."""
        if not entries:
            return
        with self.lock:
            for ref, vector, labels in entries:
                self.put_row(ref, vector, labels)
            self.save()

    def remove(self, refs: list[str]) -> int:
        """Drops rows by ref and returns how many went."""
        with self.lock:
            doomed = {ref for ref in refs if ref in self.index_by_ref}
            if not doomed:
                return 0
            keep = [position for position, ref in enumerate(self.refs) if ref not in doomed]
            self.refs = [self.refs[position] for position in keep]
            self.labels = [self.labels[position] for position in keep]
            self.vectors = self.vectors[keep] if keep else empty_matrix(self.dim)
            self.reindex()
            self.save()
            return len(doomed)

    def vector_for(self, ref: str) -> np.ndarray | None:
        with self.lock:
            position = self.index_by_ref.get(ref)
            if position is None:
                return None
            return self.vectors[position]

    def matrix(self, classes: list[str]) -> tuple[np.ndarray, np.ndarray]:
        """(X, Y) over the whole pool for a class list."""
        with self.lock:
            if not self.refs:
                return empty_matrix(self.dim), np.zeros((0, len(classes)), dtype=np.float32)
            class_index = {name: position for position, name in enumerate(classes)}
            targets = np.zeros((len(self.refs), len(classes)), dtype=np.float32)
            for row, labels in enumerate(self.labels):
                for name in labels:
                    if name in class_index:
                        targets[row, class_index[name]] = 1.0
            return self.vectors.copy(), targets

    def entries(self) -> list[tuple[str, list[str]]]:
        with self.lock:
            return [(ref, list(labels)) for ref, labels in zip(self.refs, self.labels)]

    def label_names(self) -> list[str]:
        with self.lock:
            return sorted({name for labels in self.labels for name in labels})

    def count(self) -> int:
        with self.lock:
            return len(self.refs)


class VectorCache:
    """Persisted embeddings for refs that carry no label yet.

    A capped FIFO cache, not a record: it evicts oldest-first and saves on a debounce so a
    batch of embeds costs one write. `close` cancels the pending timer and flushes.
    """

    def __init__(self, encoder_id: str, dim: int, directory: str,
                 capacity: int = 20000, flush_seconds: float = 5.0):
        self.encoder_id = encoder_id
        self.dim = dim
        self.directory = directory
        self.capacity = capacity
        self.flush_seconds = flush_seconds
        self.lock = threading.Lock()
        self.vectors: dict[str, np.ndarray] = {}
        self.flush_timer: threading.Timer | None = None
        self.closed = False

        os.makedirs(self.directory, exist_ok=True)
        self.load()

    def path(self) -> str:
        return os.path.join(self.directory, "vectors.npz")

    def load(self) -> None:
        if not os.path.exists(self.path()):
            return
        try:
            data = np.load(self.path(), allow_pickle=True)
        except Exception as error:
            log(f"vector cache load: {error}")
            return
        if "encoder_id" not in data.files or str(data["encoder_id"]) != self.encoder_id:
            return
        matrix = data["vectors"].astype(np.float32)
        if matrix.shape[1:] != (self.dim,):
            return
        self.vectors = {ref: matrix[row] for row, ref in enumerate(data["refs"])}

    def get(self, ref: str) -> np.ndarray | None:
        with self.lock:
            return self.vectors.get(ref)

    def put(self, entries: dict[str, np.ndarray]) -> None:
        if not entries:
            return
        with self.lock:
            self.vectors.update(entries)
            self.evict()
        self.schedule_flush()

    def drop(self, refs: list[str]) -> None:
        with self.lock:
            removed = [ref for ref in refs if self.vectors.pop(ref, None) is not None]
        if removed:
            self.schedule_flush()

    def evict(self) -> None:
        """Dicts keep insertion order, so the front is the oldest entry."""
        overflow = len(self.vectors) - self.capacity
        if overflow <= 0:
            return
        for ref in list(self.vectors)[:overflow]:
            del self.vectors[ref]

    def schedule_flush(self) -> None:
        with self.lock:
            if self.flush_timer is not None or self.closed:
                return
            self.flush_timer = threading.Timer(self.flush_seconds, self.flush)
            self.flush_timer.daemon = True
            self.flush_timer.start()

    def flush(self) -> None:
        with self.lock:
            self.flush_timer = None
            refs = list(self.vectors)
            matrix = empty_matrix(self.dim)
            if refs:
                matrix = np.stack([self.vectors[ref] for ref in refs]).astype(np.float32)
        try:
            np.savez(self.path(), encoder_id=self.encoder_id,
                     refs=np.array(refs, dtype=object), vectors=matrix)
        except Exception as error:
            log(f"vector cache save: {error}")

    def close(self) -> None:
        """Cancels the debounce timer and writes whatever is pending."""
        with self.lock:
            self.closed = True
            timer = self.flush_timer
            self.flush_timer = None
        if timer is not None:
            timer.cancel()
        self.flush()

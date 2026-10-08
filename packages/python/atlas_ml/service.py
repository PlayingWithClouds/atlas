"""ModelService: composes an Encoder with per-project pools, heads and rankers.

Methods mirror the `ModelProvider` contract and return camelCase JSON. Vectors never leave
this process. Calls other than `embed` never run the encoder, so a cheap call never queues
behind minutes of decoding.
"""

import threading
from dataclasses import dataclass, field

import numpy as np

from atlas_ml.encoder import Encoder, MediaItem, media_item_from_json
from atlas_ml.heads import Head, create_head
from atlas_ml.insights import compute_insights
from atlas_ml.log import log
from atlas_ml.pool import TrainPool, VectorCache, pool_directory
from atlas_ml.uncertainty import get_strategy
from atlas_ml.vectors import cosine, greedy_cosine_groups, unit_rows, usable_rows

EMBED_CHUNK = 16
MIN_LABELS_TO_TRAIN = 4


@dataclass
class ProjectState:
    pool: TrainPool
    cache: VectorCache
    embed_lock: threading.Lock = field(default_factory=threading.Lock)
    lock: threading.RLock = field(default_factory=threading.RLock)
    version: int = 0
    heads: dict[tuple, tuple[int, Head]] = field(default_factory=dict)
    refitting: set = field(default_factory=set)


class ModelService:
    def __init__(self, encoder: Encoder, cache_root: str, head_name: str = "linear-probe",
                 strategy: str = "margin-sum", device: str = "cpu"):
        self.encoder = encoder
        self.cache_root = cache_root
        self.head_name = head_name
        self.strategy = strategy
        self.device = device
        self.states: dict[str, ProjectState] = {}
        self.states_lock = threading.Lock()
        self.refit_threads: list[threading.Thread] = []
        get_strategy(strategy)

    # --- project state ----------------------------------------------------------------

    def state_for(self, project_id: str) -> ProjectState:
        with self.states_lock:
            state = self.states.get(project_id)
            if state is None:
                state = self.open_state(project_id)
                self.states[project_id] = state
            return state

    def open_state(self, project_id: str) -> ProjectState:
        directory = pool_directory(self.cache_root, self.encoder.id, project_id)
        return ProjectState(
            pool=TrainPool(self.encoder.id, self.encoder.dim, directory),
            cache=VectorCache(self.encoder.id, self.encoder.dim, directory),
        )

    def vector_for(self, state: ProjectState, ref: str) -> np.ndarray | None:
        vector = state.pool.vector_for(ref)
        if vector is not None:
            return vector
        return state.cache.get(ref)

    def embedded_refs(self, state: ProjectState, refs: list[str]) -> list[str]:
        return [ref for ref in refs if self.vector_for(state, ref) is not None]

    def stack_vectors(self, state: ProjectState, refs: list[str]) -> np.ndarray:
        rows = [self.vector_for(state, ref) for ref in refs]
        if not rows:
            return np.zeros((0, self.encoder.dim), dtype=np.float32)
        return np.array(rows, dtype=np.float32)

    def close(self) -> None:
        self.wait_idle()
        with self.states_lock:
            states = list(self.states.values())
        for state in states:
            state.cache.close()

    def wait_idle(self, timeout: float = 30.0) -> None:
        """Blocks until background refits finish."""
        with self.states_lock:
            threads = list(self.refit_threads)
        for thread in threads:
            thread.join(timeout)

    # --- embed / forget ---------------------------------------------------------------

    def embed(self, project_id: str, items: list[dict]) -> dict:
        state = self.state_for(project_id)
        media_items = self.unique_items(items)
        missing = [item for item in media_items if self.vector_for(state, item.ref) is None]
        if missing:
            self.embed_missing(state, missing)
        refs = [item.ref for item in media_items]
        return {"embedded": self.embedded_refs(state, refs)}

    def unique_items(self, items: list[dict]) -> list[MediaItem]:
        by_ref: dict[str, MediaItem] = {}
        for payload in items:
            by_ref.setdefault(payload["ref"], media_item_from_json(payload))
        return list(by_ref.values())

    def embed_missing(self, state: ProjectState, missing: list[MediaItem]) -> None:
        # One embed at a time per project: the encoder is a single pipeline, so
        # overlapping callers would only duplicate work on the same refs.
        failures: list[Exception] = []
        with state.embed_lock:
            for start in range(0, len(missing), EMBED_CHUNK):
                chunk = missing[start:start + EMBED_CHUNK]
                chunk = [item for item in chunk if self.vector_for(state, item.ref) is None]
                self.embed_chunk(state, chunk, failures)
        if failures and not self.embedded_refs(state, [item.ref for item in missing]):
            raise failures[-1]

    def embed_chunk(self, state: ProjectState, chunk: list[MediaItem],
                    failures: list[Exception]) -> None:
        if not chunk:
            return
        try:
            vectors = self.checked_embedding(chunk)
        except Exception as error:
            log(f"embed failed for {len(chunk)} items: {error}")
            failures.append(error)
            return
        state.cache.put(vectors)

    def checked_embedding(self, chunk: list[MediaItem]) -> dict[str, np.ndarray]:
        matrix = np.asarray(self.encoder.embed(chunk), dtype=np.float32)
        expected = (len(chunk), self.encoder.dim)
        if matrix.shape != expected:
            raise ValueError(f"encoder returned shape {matrix.shape}, expected {expected}")
        # Undecodable items come back as zero/non-finite rows; pooling them would bias heads.
        valid = usable_rows(matrix)
        unit = unit_rows(np.nan_to_num(matrix))
        return {item.ref: unit[row] for row, item in enumerate(chunk) if valid[row]}

    def forget(self, project_id: str, refs: list[str]) -> None:
        state = self.state_for(project_id)
        removed = state.pool.remove(list(refs))
        state.cache.drop(list(refs))
        if removed:
            self.bump_version(state)

    def bump_version(self, state: ProjectState) -> None:
        with state.lock:
            state.version += 1

    # --- training ---------------------------------------------------------------------

    def train(self, project_id: str, labeled: list[dict], classes: list[str]) -> dict:
        state = self.state_for(project_id)
        entries = []
        for entry in labeled:
            vector = self.vector_for(state, entry["ref"])
            if vector is not None:
                entries.append((entry["ref"], vector, list(entry["labels"])))
        if entries:
            state.pool.upsert_many(entries)
            self.bump_version(state)
        pool_size = state.pool.count()
        if pool_size >= MIN_LABELS_TO_TRAIN:
            self.schedule_refit(state, tuple(classes))
        return {"poolSize": pool_size}

    def head_for(self, state: ProjectState, classes: list[str]) -> Head | None:
        """Returns the cached head immediately, possibly stale; never blocks on a fit."""
        key = tuple(classes)
        with state.lock:
            cached = state.heads.get(key)
            if cached is None:
                self.refit_if_enough_labels(state, key)
                return None
            if cached[0] != state.version:
                self.schedule_refit(state, key)
            return cached[1]

    def refit_if_enough_labels(self, state: ProjectState, key: tuple) -> None:
        if state.pool.count() >= MIN_LABELS_TO_TRAIN:
            self.schedule_refit(state, key)

    def schedule_refit(self, state: ProjectState, key: tuple) -> None:
        with state.lock:
            if key in state.refitting:
                return
            state.refitting.add(key)
            version = state.version
        thread = threading.Thread(target=self.refit, args=(state, key, version), daemon=True)
        with self.states_lock:
            self.refit_threads = [alive for alive in self.refit_threads if alive.is_alive()]
            self.refit_threads.append(thread)
        thread.start()

    def refit(self, state: ProjectState, key: tuple, version: int) -> None:
        try:
            features, targets = state.pool.matrix(list(key))
            if features.shape[0] >= MIN_LABELS_TO_TRAIN:
                head = create_head(self.head_name, list(key), self.device)
                head.fit(features, targets)
                with state.lock:
                    state.heads[key] = (version, head)
        except Exception as error:
            log(f"refit failed: {error}")
        finally:
            with state.lock:
                state.refitting.discard(key)

    def trained_head(self, state: ProjectState, classes: list[str]) -> Head | None:
        head = self.head_for(state, classes)
        if head is None or not head.trained:
            return None
        return head

    # --- inference --------------------------------------------------------------------

    def predict(self, project_id: str, refs: list[str], classes: list[str]) -> dict:
        state = self.state_for(project_id)
        head = self.trained_head(state, classes)
        if head is None:
            return {ref: {} for ref in refs}
        ready = self.embedded_refs(state, refs)
        predictions: dict[str, dict] = {ref: {} for ref in refs}
        if not ready:
            return predictions
        probabilities = head.predict(self.stack_vectors(state, ready))
        for row, ref in enumerate(ready):
            predictions[ref] = {name: round(float(probabilities[row][column]), 3)
                                for column, name in enumerate(classes)}
        return predictions

    def rank(self, project_id: str, refs: list[str], classes: list[str],
             strategy: str | None = None) -> dict:
        state = self.state_for(project_id)
        head = self.trained_head(state, classes)
        ready = self.embedded_refs(state, refs)
        if head is None or not ready:
            return {"order": list(refs), "trained": head is not None}
        score = get_strategy(strategy or self.strategy)
        scores = score(head.predict(self.stack_vectors(state, ready)))
        order = [ready[index] for index in np.argsort(-scores, kind="stable")]
        ready_set = set(ready)
        order += [ref for ref in refs if ref not in ready_set]
        return {"order": order, "trained": True}

    # --- geometry ---------------------------------------------------------------------

    def cluster(self, project_id: str, refs: list[str], threshold: float) -> list[dict]:
        state = self.state_for(project_id)
        ready = self.embedded_refs(state, list(dict.fromkeys(refs)))
        if not ready:
            return []
        groups = greedy_cosine_groups(self.stack_vectors(state, ready), threshold)
        clusters = []
        for group in groups:
            members = [ready[index] for index in group]
            clusters.append({"keep": members[0], "members": members})
        return clusters

    def duplicates(self, project_id: str, refs: list[str], threshold: float) -> list[dict]:
        groups = self.cluster(project_id, refs, threshold)
        return [{"keep": group["keep"], "duplicates": group["members"][1:]}
                for group in groups if len(group["members"]) > 1]

    def similarity(self, project_id: str, refs: list[str]) -> list[float]:
        state = self.state_for(project_id)
        vectors = [self.vector_for(state, ref) for ref in refs]
        return [cosine(vectors[index], vectors[index + 1]) for index in range(len(refs) - 1)]

    def search(self, project_id: str, query: str, refs: list[str], limit: int) -> list[dict]:
        embed_text = getattr(self.encoder, "embed_text", None)
        if embed_text is None:
            raise ValueError(f"encoder '{self.encoder.id}' does not support text search")
        state = self.state_for(project_id)
        ready = self.embedded_refs(state, refs)
        if not ready or not query.strip():
            return []
        text_vector = unit_rows(np.asarray(embed_text([query.strip()]), dtype=np.float32))[0]
        scores = unit_rows(self.stack_vectors(state, ready)) @ text_vector
        top = np.argsort(-scores, kind="stable")[:max(int(limit), 1)]
        return [{"ref": ready[index], "score": round(float(scores[index]), 4)} for index in top]

    # --- reporting --------------------------------------------------------------------

    def insights(self, project_id: str, classes: list[str]) -> dict:
        state = self.state_for(project_id)
        names = sorted(classes)
        if not names:
            names = state.pool.label_names()
        features, targets = state.pool.matrix(names)
        return compute_insights(features, targets, names, state.pool.count(),
                                lambda class_names: create_head(
                                    self.head_name, class_names, self.device))

    def status(self, project_id: str, classes: list[str]) -> dict:
        pool_size = self.state_for(project_id).pool.count()
        return {"poolSize": pool_size, "trained": pool_size >= MIN_LABELS_TO_TRAIN}

    def pool_dump(self, project_id: str) -> list[dict]:
        entries = self.state_for(project_id).pool.entries()
        return [{"ref": ref, "labels": labels} for ref, labels in entries]

"""Model plugin — the app's ML brain, per project.

Owns the embedding backbone (shared), and a SEPARATE training pool + classifier head
per project, so projects don't cross-contaminate. The default project `nsfw-tags` uses
the legacy `~/.cache/atlas/global` pool; other projects use
`~/.cache/atlas/projects/<id>/pool`.

Vectors stay inside this process: embed() returns which refs are now embedded, predict()
returns probabilities, rank() returns an order, duplicates() clusters by cosine, insights()
cross-validates — never the raw vectors. This is the only Python in atlas; the Go core does
no ML.

Run:  uvicorn plugins.model.main:app --port 9301   (from the repo root)
Env:  ATLAS_DEVICE (force cpu/cuda), MODEL_BACKBONE (default joytag)
"""

import os
import sys
import threading

import numpy as np
from sklearn.metrics import average_precision_score, precision_recall_curve
from sklearn.model_selection import KFold

_HERE = os.path.dirname(__file__)
_REPO = os.path.dirname(os.path.dirname(_HERE))
sys.path.insert(0, _HERE)                          # classifier / embedder / trainset
sys.path.insert(0, os.path.join(_REPO, "sdk", "python"))  # atlas_plugin_sdk

from atlas_plugin_sdk import Plugin  # noqa: E402
from classifier import TorchHead, uncertainty_scores  # noqa: E402
from embedder import Embedder, JoyTagEmbedder, SiglipEmbedder  # noqa: E402
from trainset import CACHE_ROOT, GLOBAL_DIR, GlobalTrainSet, VectorCache  # noqa: E402

DEVICE = os.environ.get("ATLAS_DEVICE") or None
BACKBONE = os.environ.get("MODEL_BACKBONE", "joytag")
# A second instance runs this same code with a distinct id/backbone (e.g. siglip) so
# per-frame (joytag) and per-clip (siglip) pools coexist. MODEL_ID keeps their vector
# pools and plugin identity separate; NODE_PREFIX keeps their workflow nodes distinct.
MODEL_ID = os.environ.get("MODEL_ID", "model")
NODE_PREFIX = os.environ.get("NODE_PREFIX", "")
DEFAULT_PROJECT = "nsfw-tags"
MIN_LABELS_TO_TRAIN = 4
MIN_POOL_FOR_INSIGHTS = 8
MIN_PER_CLASS = 4  # need enough positives AND negatives to cross-validate a class
_DIM = {"joytag": 768, "siglip": 1152,
        "vit_small_patch14_dinov2.lvd142m": 384, "vit_base_patch14_dinov2.lvd142m": 768}

# _lock guards the in-memory tables only. Embedding must never run under it: a batch of
# video clips is minutes of ffmpeg, and every cheap call (status, predict on an already
# embedded ref) would queue behind it, which reads as a frozen UI.
_lock = threading.RLock()                           # reentrant: _head_for runs under it
_embedder = None                                    # shared: one backbone
_embedder_lock = threading.Lock()                   # first use loads ~2GB of weights
_pools: dict[str, GlobalTrainSet] = {}              # project -> pool
_caches: dict[str, VectorCache] = {}                # project -> unlabeled ref vectors
_embed_locks: dict[str, threading.Lock] = {}        # project -> serializes its embeds
_heads: dict[str, dict[tuple, tuple[int, TorchHead | None]]] = {}
_versions: dict[str, int] = {}
_refitting: set = set()                             # (project, classes) refits in flight
EMBED_CHUNK = 16


def _dim() -> int:
    return _DIM.get(BACKBONE, 768)


def _pool_root() -> str:
    # The legacy "model" id keeps ~/.cache/atlas/{global,projects}; a second instance
    # (e.g. siglip) is namespaced under its id so its differently-dimensioned pool never
    # overwrites the model plugin's.
    if MODEL_ID == "model":
        return CACHE_ROOT
    return os.path.join(CACHE_ROOT, MODEL_ID)


def _pool_dir(project: str) -> str:
    root = _pool_root()
    if project == DEFAULT_PROJECT:
        if root == CACHE_ROOT:
            return GLOBAL_DIR
        return os.path.join(root, "global")
    return os.path.join(root, "projects", project, "pool")


def _make_embedder():
    if BACKBONE == "joytag":
        return JoyTagEmbedder(device=DEVICE)
    if BACKBONE == "siglip":
        return SiglipEmbedder(device=DEVICE)
    return Embedder(BACKBONE, device=DEVICE)


def _get_embedder():
    global _embedder
    with _embedder_lock:
        if _embedder is None:
            _embedder = _make_embedder()
        return _embedder


def _get_pool(project: str) -> GlobalTrainSet:
    if project not in _pools:
        _pools[project] = GlobalTrainSet(BACKBONE, _dim(), dir=_pool_dir(project))
        _caches[project] = VectorCache(BACKBONE, _dim(), dir=_pool_dir(project))
        _heads[project] = {}
        _versions[project] = 0
    return _pools[project]


def _vector(project: str, ref: str):
    pool = _get_pool(project)
    index = pool.index_by_ref.get(ref)
    if index is not None:
        return pool.vectors[index]
    return _caches[project].get(ref)


def _embed_lock(project: str) -> threading.Lock:
    with _lock:
        return _embed_locks.setdefault(project, threading.Lock())


def _ensure_vectors(project: str, refs: list[str]) -> None:
    """Embed whatever has no vector yet. Call this OUTSIDE _lock — it is the slow part,
    and holding the table lock across it starves every other request."""
    with _lock:
        _get_pool(project)
        missing = [ref for ref in dict.fromkeys(refs) if _vector(project, ref) is None]
    if not missing:
        return

    # One embed at a time per project: the backbone is a single GPU/CPU pipeline, so
    # overlapping callers would only duplicate work on the same refs.
    with _embed_lock(project):
        for start in range(0, len(missing), EMBED_CHUNK):
            with _lock:
                chunk = [ref for ref in missing[start : start + EMBED_CHUNK]
                         if _vector(project, ref) is None]
            if not chunk:
                continue
            try:
                vectors = _get_embedder().embed_refs(chunk)
            except Exception as error:
                print(f"embed @{start}: {error}")
                continue
            # A backbone may report None for a ref it could not decode; leaving it
            # unembedded is correct, a zero vector would pollute the pool.
            fresh = {ref: vector for ref, vector in zip(chunk, vectors) if vector is not None}
            _caches[project].put(fresh)


def _head_for(project: str, classes) -> TorchHead | None:
    """Return the cached head immediately (never blocks). If it's missing or stale,
    schedule a background refit and return whatever we have now — a one-label-stale head
    is fine for active learning, and refitting takes seconds, which must not block the
    label/next request path."""
    key = tuple(classes)
    cached = _heads.get(project, {}).get(key)
    if cached is not None:
        if cached[0] != _versions.get(project, 0):
            _schedule_refit(project, key)
        return cached[1]
    if _get_pool(project).count() >= MIN_LABELS_TO_TRAIN:
        _schedule_refit(project, key)
    return None


def _schedule_refit(project: str, key: tuple) -> None:
    guard = (project, key)
    with _lock:
        if guard in _refitting:
            return
        _refitting.add(guard)
    version = _versions.get(project, 0)

    def worker():
        try:
            pool = _get_pool(project)
            X, Y = pool.matrix(list(key))  # GlobalTrainSet locks internally
            if X.shape[0] >= MIN_LABELS_TO_TRAIN:
                head = TorchHead(list(key), device=DEVICE)
                head.fit(X, Y)  # the slow part — runs off the request path
                with _lock:
                    _heads.setdefault(project, {})[key] = (version, head)
        except Exception as error:
            print(f"refit {project}: {error}")
        finally:
            with _lock:
                _refitting.discard(guard)

    threading.Thread(target=worker, daemon=True).start()


plugin = Plugin(MODEL_ID)
plugin.declare("embed", backbone=BACKBONE, dim=_dim())
plugin.declare("model", annotation_types=["tag"], singleton=True, backbone=BACKBONE)


def _node_type(name: str) -> str:
    return f"{NODE_PREFIX}{name}"

# Workflow designer nodes provided by this plugin. The backend delegates
# generically: it sends the entity items matching `accepts` to `method` as
# {items, params, project, classes} and takes {items: [...]} as the node output.
# Result fields are persisted by the builtin Save node (embedded, annotations);
# items carrying an "action" field are applied to the entities and consumed.
plugin.declare(
    "node",
    type=_node_type("embed"),
    label="Embed",
    description="Compute embeddings for unembedded images",
    method="node.embed",
    accepts={"embedded": False},
    emits={"embedded": True},
    batch=16,
    params=[],
)
plugin.declare(
    "node",
    type=_node_type("predict"),
    label="Predict",
    description="Propose annotations above a threshold (pending human review)",
    method="node.predict",
    accepts={"status": "pending", "embedded": True},
    emits={"annotation": "tag"},
    batch=64,
    params=[{"key": "threshold", "kind": "number", "label": "Threshold",
             "default": 0.5, "min": 0, "max": 1, "step": 0.05}],
)
plugin.declare(
    "node",
    type=_node_type("cluster"),
    label="Cluster",
    description="Group entities that look alike and mark one representative per group",
    method="node.cluster",
    accepts={"embedded": True},
    emits={"cluster": "id"},
    params=[{"key": "threshold", "kind": "number", "label": "Similarity",
             "default": 0.9, "min": 0, "max": 1, "step": 0.01}],
)
plugin.declare(
    "node",
    type=_node_type("propagate"),
    label="Propagate labels",
    description="Copy a labeled entity's tags onto the unlabeled entities that look like it",
    method="node.propagate",
    accepts={"embedded": True},
    emits={"annotation": "tag"},
    params=[{"key": "threshold", "kind": "number", "label": "Similarity",
             "default": 0.92, "min": 0, "max": 1, "step": 0.01}],
)
plugin.declare(
    "node",
    type=_node_type("dedupe"),
    label="Deduplicate",
    description="Skip or delete near-duplicate images (embedding cosine similarity)",
    method="node.dedupe",
    accepts={"embedded": True},
    params=[{"key": "threshold", "kind": "number", "label": "Similarity",
             "default": 0.93, "min": 0, "max": 1, "step": 0.01},
            {"key": "action", "kind": "option", "label": "On duplicate",
             "default": "skip", "options": ["skip", "delete"]}],
)


def _item_refs(items):
    return [item["ref"] for item in items if item.get("ref")]


@plugin.method("node.embed")
def node_embed(items, params=None, project=DEFAULT_PROJECT, classes=None):
    refs = _item_refs(items)
    done = set(embed(refs, project)["embedded"])
    return {"items": [{"ref": ref, "embedded": True} for ref in refs if ref in done]}


@plugin.method("node.predict")
def node_predict(items, params=None, project=DEFAULT_PROJECT, classes=None):
    threshold = float((params or {}).get("threshold", 0.5))
    refs = _item_refs(items)
    out = []
    proposed = 0
    best_name, best_prob = "", 0.0
    for prediction in predict(refs, classes or [], project)["predictions"]:
        labels = [name for name, prob in prediction["probs"].items() if prob >= threshold]
        proposed += len(labels)
        for name, prob in prediction["probs"].items():
            if prob > best_prob:
                best_name, best_prob = name, prob
        # Always emit annotations (possibly empty) so Save clears stale proposals.
        # confidence is the strongest class for this entity, carried on the item so a
        # downstream filter can route on it (auto-confirm the sure ones, queue the rest).
        confidence = max(prediction["probs"].values(), default=0.0)
        out.append({"ref": prediction["ref"], "confidence": round(float(confidence), 4),
                    "probs": prediction["probs"],
                    "annotations": [{"type": "tag", "value": {"labels": labels}}]})

    result = {"items": out}
    if out and proposed == 0:
        result["message"] = _nothing_proposed_reason(
            project, classes or [], threshold, best_name, best_prob)
    return result


def _nothing_proposed_reason(project: str, classes, threshold: float,
                             best_name: str, best_prob: float) -> str:
    """Why a predict node ran over entities and proposed no tag at all.

    Too few labels, a head still fitting, and a threshold nothing reached all look
    identical downstream — empty annotations — so the distinction has to come from here.
    """
    missing = _labels_needed_to_train(project)
    if missing > 0:
        entities = "entity" if missing == 1 else "entities"
        return (f"Predict proposed nothing: the {project} model needs {missing} more "
                f"labeled {entities} before it can train")
    if not best_name:
        if _head_is_fitting(project, classes):
            return ("Predict proposed nothing: the model is still fitting — "
                    "run this again in a few seconds")
        return "Predict proposed nothing: the model returned no probabilities for these entities"
    return (f"Predict proposed nothing: no tag reached the {threshold:.2f} threshold "
            f"(best was {best_name} at {best_prob:.2f})")


def _head_is_fitting(project: str, classes) -> bool:
    """True while a refit is running, or scheduled but not yet cached — the state a
    predict lands in right after a restart or a fresh label."""
    key = tuple(classes)
    with _lock:
        if (project, key) in _refitting:
            return True
        return _heads.get(project, {}).get(key) is None


def _labels_needed_to_train(project: str) -> int:
    with _lock:
        return max(0, MIN_LABELS_TO_TRAIN - _get_pool(project).count())


@plugin.method("node.cluster")
def node_cluster(items, params=None, project=DEFAULT_PROJECT, classes=None):
    threshold = float((params or {}).get("threshold", 0.9))
    refs = _item_refs(items)
    groups = cluster(refs, threshold, project)["clusters"]

    membership = {}
    for number, group in enumerate(groups):
        for ref in group["members"]:
            membership[ref] = (number, ref == group["keep"])

    out = []
    for ref in refs:
        # A ref with no vector belongs to no group; calling it its own representative
        # keeps a downstream "representatives only" filter from dropping it silently.
        number, representative = membership.get(ref, (-1, True))
        out.append({"ref": ref, "cluster": number, "representative": representative})
    return {"items": out}


@plugin.method("node.propagate")
def node_propagate(items, params=None, project=DEFAULT_PROJECT, classes=None):
    """Copy the tags of labeled entities onto the unlabeled ones that look like them.

    This is the throughput win the pool alone cannot give: label one clip of an act and
    the rest of its cluster arrives as proposals. Only entities above the threshold get
    annotations — the rest pass through untouched so a Save node does not wipe whatever
    a predict node proposed for them earlier."""
    threshold = float((params or {}).get("threshold", 0.92))
    labeled = [item for item in items if item.get("status") == "labeled" and _tags_of(item)]
    targets = [item for item in items if item.get("status") != "labeled"]
    if not labeled or not targets:
        return {"items": items, "message": _nothing_to_propagate(labeled, targets)}

    _ensure_vectors(project, _item_refs(items))
    with _lock:
        sources = [(item, _vector(project, item["ref"])) for item in labeled]
        sources = [(item, vector) for item, vector in sources if vector is not None]
        vectors = {item["ref"]: _vector(project, item["ref"]) for item in targets}
    if not sources:
        return {"items": items}

    source_matrix = _unit_rows(np.array([vector for _, vector in sources], dtype=np.float32))
    proposals = {}
    for item in targets:
        vector = vectors.get(item["ref"])
        if vector is None:
            continue
        scores = source_matrix @ _unit_rows(np.array([vector], dtype=np.float32))[0]
        best = int(np.argmax(scores))
        if float(scores[best]) >= threshold:
            proposals[item["ref"]] = (round(float(scores[best]), 4), _tags_of(sources[best][0]))

    # Every input item comes back, in order: entities below the threshold pass through
    # untouched rather than carrying an empty annotation list, which a Save node would
    # apply as "clear whatever was proposed here".
    out = []
    for item in items:
        match = proposals.get(item.get("ref"))
        if match is None:
            out.append(item)
            continue
        score, labels = match
        out.append({"ref": item["ref"], "confidence": score,
                    "annotations": [{"type": "tag", "value": {"labels": labels}}]})
    return {"items": out}


def _tags_of(item) -> list:
    """The class labels on an entity's tag annotations."""
    labels = []
    for annotation in item.get("annotations") or []:
        if annotation.get("type") != "tag":
            continue
        labels.extend(str(label) for label in (annotation.get("value") or {}).get("labels", []))
    return labels


def _nothing_to_propagate(labeled, unlabeled) -> str:
    if not labeled:
        return "Propagate had nothing to copy from: no labeled entities reached it"
    return "Propagate had nothing to copy onto: every entity that reached it is labeled"


@plugin.method("node.dedupe")
def node_dedupe(items, params=None, project=DEFAULT_PROJECT, classes=None):
    params = params or {}
    threshold = float(params.get("threshold", 0.93))
    action = params.get("action", "skip")
    refs = _item_refs(items)
    result = duplicates(refs, threshold, project)
    keep_of = {dupe: cluster["keep"] for cluster in result["clusters"] for dupe in cluster["dupes"]}
    out = []
    for ref in refs:
        if ref in keep_of:
            out.append({"ref": ref, "action": action, "keep": keep_of[ref]})
        else:
            out.append({"ref": ref})
    return {"items": out}


@plugin.method("embed")
def embed(refs, project=DEFAULT_PROJECT):
    _ensure_vectors(project, refs)
    with _lock:
        return {"embedded": [ref for ref in refs if _vector(project, ref) is not None]}


@plugin.method("forget")
def forget(refs, project=DEFAULT_PROJECT):
    """Drop refs from a project's pool and vector cache. Called when an entity's identity
    changes — a trimmed temporal span gets a new media-fragment ref, and its old row would
    otherwise keep training the head on a range that no longer exists."""
    with _lock:
        removed = _get_pool(project).remove(list(refs))
        _caches[project].drop(list(refs))
        if removed:
            _versions[project] = _versions.get(project, 0) + 1
        return {"removed": removed, "pool_size": _get_pool(project).count()}


@plugin.method("status")
def status(classes=None, project=DEFAULT_PROJECT):
    with _lock:
        pool = _get_pool(project)
        return {"backbone": BACKBONE, "dim": _dim(), "pool_size": pool.count(),
                "trained": pool.count() >= MIN_LABELS_TO_TRAIN}


@plugin.method("train")
def train(labeled, classes, project=DEFAULT_PROJECT):
    _ensure_vectors(project, [entry["ref"] for entry in labeled])
    with _lock:
        entries = [(entry["ref"], _vector(project, entry["ref"]), entry["labels"])
                   for entry in labeled if _vector(project, entry["ref"]) is not None]
        if entries:
            _get_pool(project).upsert_many(entries)
            _versions[project] = _versions.get(project, 0) + 1
        pool_size = _get_pool(project).count()
    # Refit the head off the request path so labeling stays instant.
    if pool_size >= MIN_LABELS_TO_TRAIN:
        _schedule_refit(project, tuple(classes))
    return {"trained": pool_size >= MIN_LABELS_TO_TRAIN, "pool_size": pool_size}


@plugin.method("predict")
def predict(refs, classes, project=DEFAULT_PROJECT):
    _ensure_vectors(project, refs)
    with _lock:
        head = _head_for(project, classes)
        if head is None or not head.trained:
            return {"predictions": [{"ref": ref, "probs": {}} for ref in refs]}
        ready = [ref for ref in refs if _vector(project, ref) is not None]
        probmap: dict[str, dict] = {}
        if ready:
            X = np.array([_vector(project, ref) for ref in ready], dtype=np.float32)
            P = head.predict(X)
            for row, ref in enumerate(ready):
                probmap[ref] = {classes[c]: round(float(P[row][c]), 3) for c in range(len(classes))}
        return {"predictions": [{"ref": ref, "probs": probmap.get(ref, {})} for ref in refs]}


@plugin.method("rank")
def rank(refs, classes, strategy="uncertainty", project=DEFAULT_PROJECT):
    # No embedding here on purpose. Ranking runs on the "give me the next item" path
    # with every candidate in the session, so embedding on demand would mean waiting
    # for the whole session before the first clip opens. Rank what is embedded and
    # leave the rest in input order; an embed node or workflow fills them in.
    with _lock:
        head = _head_for(project, classes)
        ready = [ref for ref in refs if _vector(project, ref) is not None]
        if head is None or not head.trained or not ready:
            return {"order": refs, "trained": head is not None and head.trained}
        X = np.array([_vector(project, ref) for ref in ready], dtype=np.float32)
        scores = uncertainty_scores(head.predict(X))
        order = [ready[i] for i in np.argsort(-scores)]
        ready_set = set(ready)
        order += [ref for ref in refs if ref not in ready_set]
        return {"order": order, "trained": True}


@plugin.method("duplicates")
def duplicates(refs, threshold=0.93, project=DEFAULT_PROJECT):
    """Cluster near-duplicate images by cosine similarity of their embeddings. Returns
    clusters/dupes in terms of the input refs (the caller maps refs back to image ids).
    Video galleries especially are full of near-identical frames, so this lets the
    redundant frames be skipped or bulk-labeled in one go."""
    groups = cluster(refs, threshold, project)["clusters"]
    clusters = []
    dupes: list[str] = []
    for group in groups:
        if len(group["members"]) < 2:
            continue
        clusters.append({"keep": group["keep"], "dupes": group["members"][1:]})
        dupes.extend(group["members"][1:])
    return {"clusters": clusters, "duplicates": dupes, "count": len(dupes)}


@plugin.method("search")
def search(query, refs=None, project=DEFAULT_PROJECT, limit=50):
    """Rank refs by how well they match a free-text query.

    SigLIP is contrastive, so the text tower encodes a query into the same space the clip
    vectors already live in: searching is a cosine sort over vectors that are on disk
    already. No labels are involved and nothing is embedded here — refs without a vector
    are reported as skipped rather than being embedded on a search path, which would turn
    a keystroke into minutes of ffmpeg.
    """
    query = (query or "").strip()
    if not query:
        return {"results": [], "scored": 0, "unembedded": 0}
    if BACKBONE != "siglip":
        return {"results": [], "scored": 0, "unembedded": 0,
                "message": f"text search needs the siglip backbone; this plugin runs {BACKBONE}"}

    with _lock:
        _get_pool(project)
        pairs = [(ref, _vector(project, ref)) for ref in (refs or [])]
    ready = [(ref, vector) for ref, vector in pairs if vector is not None]
    if not ready:
        return {"results": [], "scored": 0, "unembedded": len(pairs)}

    text = _get_text_encoder().encode([query])[0]
    matrix = _unit_rows(np.array([vector for _, vector in ready], dtype=np.float32))
    scores = matrix @ text

    order = np.argsort(-scores)[: max(int(limit or 50), 1)]
    results = [{"ref": ready[position][0], "score": round(float(scores[position]), 4)}
               for position in order]
    return {"results": results, "scored": len(ready), "unembedded": len(pairs) - len(ready)}


_text_encoder = None
_text_encoder_lock = threading.Lock()


def _get_text_encoder():
    global _text_encoder
    with _text_encoder_lock:
        if _text_encoder is None:
            from embedder import SiglipTextEncoder

            _text_encoder = SiglipTextEncoder()
        return _text_encoder


@plugin.method("cluster")
def cluster(refs, threshold=0.9, project=DEFAULT_PROJECT):
    """Group refs by cosine similarity, keeping every group — including groups of one.

    duplicates() answers "what can be thrown away" and so reports only groups larger than
    one; this answers "what is the same thing", which is what label propagation and
    representative sampling need."""
    refs = list(refs)
    _ensure_vectors(project, refs)
    with _lock:
        ready = [ref for ref in refs if _vector(project, ref) is not None]
        if not ready:
            return {"clusters": []}
        X = np.array([_vector(project, ref) for ref in ready], dtype=np.float32)

    Xn = _unit_rows(X)
    used = np.zeros(len(ready), dtype=bool)
    clusters = []
    for a in range(len(ready)):
        if used[a]:
            continue
        sims = Xn[a] @ Xn.T
        members = [b for b in range(len(ready)) if not used[b] and sims[b] >= threshold]
        for b in members:
            used[b] = True
        member_refs = [ready[b] for b in members]
        clusters.append({"keep": member_refs[0], "members": member_refs})
    return {"clusters": clusters}


def _unit_rows(X):
    """L2-normalize each row, leaving zero rows alone so a dot product stays a cosine."""
    norms = np.linalg.norm(X, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return X / norms


@plugin.method("similarity")
def similarity(refs, project=DEFAULT_PROJECT):
    """Cosine similarity between each consecutive pair of refs (one score fewer than
    there are refs). Scene segmentation embeds candidate clips in playback order and
    merges the neighbours that turn out to be the same content; the merging itself lives
    in the core, so only these scalars leave the process.

    A ref that could not be embedded scores 0.0 against both its neighbours, which reads
    downstream as "not the same content" and leaves the boundary in place."""
    refs = list(refs)
    if len(refs) < 2:
        return {"scores": []}
    _ensure_vectors(project, refs)
    with _lock:
        vectors = [_vector(project, ref) for ref in refs]

    scores = [_cosine(vectors[index], vectors[index + 1]) for index in range(len(refs) - 1)]
    return {"scores": scores}


def _cosine(a, b) -> float:
    if a is None or b is None:
        return 0.0
    norms = float(np.linalg.norm(a) * np.linalg.norm(b))
    if norms == 0:
        return 0.0
    return round(float(np.dot(a, b) / norms), 4)


@plugin.method("insights")
def insights(classes=None, project=DEFAULT_PROJECT):
    """Cross-validated per-class precision/recall/F1/PR-AUC over the project's pool.
    One multi-label linear probe (TorchHead) per fold gives out-of-fold probabilities
    for all classes at once on the GPU."""
    with _lock:
        pool = _get_pool(project)
        total = pool.count()
        if total < MIN_POOL_FOR_INSIGHTS:
            return {"pool": total, "backbone": BACKBONE, "classes": []}
        names = sorted({tag for labels in pool.labels for tag in labels})
        if not names:
            return {"pool": total, "backbone": BACKBONE, "classes": []}
        X, Y = pool.matrix(names)

    total = X.shape[0]
    folds = int(min(5, total))
    oof = np.zeros_like(Y, dtype=np.float32)
    for train_idx, val_idx in KFold(n_splits=folds, shuffle=True, random_state=0).split(X):
        head = TorchHead(names, device=DEVICE)
        head.fit(X[train_idx], Y[train_idx])
        oof[val_idx] = head.predict(X[val_idx])

    results = []
    for index, name in enumerate(names):
        y = Y[:, index].astype(int)
        positives = int(y.sum())
        negatives = total - positives
        entry = {"name": name, "support": positives, "negatives": negatives, "evaluated": False}
        if positives >= MIN_PER_CLASS and negatives >= MIN_PER_CLASS:
            try:
                proba = oof[:, index]
                precision, recall, thresholds = precision_recall_curve(y, proba)
                f1_curve = 2 * precision * recall / (precision + recall + 1e-9)
                best = int(f1_curve.argmax())
                entry.update(
                    average_precision=round(float(average_precision_score(y, proba)), 3),
                    f1=round(float(f1_curve[best]), 3),
                    precision=round(float(precision[best]), 3),
                    recall=round(float(recall[best]), 3),
                    threshold=round(float(thresholds[best]) if best < len(thresholds) else 1.0, 3),
                    baserate=round(positives / total, 3),
                    folds=folds,
                    evaluated=True,
                )
            except Exception as error:
                entry["error"] = str(error)
        results.append(entry)

    results.sort(key=lambda e: (not e["evaluated"], e.get("average_precision", 1.0), -e["support"]))
    return {"pool": total, "backbone": BACKBONE, "classes": results}


@plugin.method("pool_dump")
def pool_dump(project=DEFAULT_PROJECT):
    """Dump the pool's (ref, labels) rows so the core can export a dataset. Vectors are
    not included — the core re-fetches image bytes by ref."""
    with _lock:
        pool = _get_pool(project)
        return {"entries": [{"ref": ref, "labels": list(labels)}
                            for ref, labels in zip(pool.refs, pool.labels)]}


app = plugin.app()

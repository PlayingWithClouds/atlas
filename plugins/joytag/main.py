"""JoyTag plugin — teacher model proposing tags for human review.

Runs the full JoyTag tagger (not just its embeddings, which the model plugin
uses) and exposes one workflow node: it takes pending entities, predicts
Danbooru tags, maps them to the session's taxonomy classes (mapping.py), and
emits tag annotations. A downstream Save node persists them as proposals
(pending human review) or confirmed labels.

Run:  plugins/model/.venv/bin/uvicorn plugins.joytag.main:app --port 9302
      (shares the model plugin's venv — same torch/fastapi dependency set)
Env:  ATLAS_DEVICE (force cpu/cuda)
"""

import os
import sys
import threading

_HERE = os.path.dirname(__file__)
_REPO = os.path.dirname(os.path.dirname(_HERE))
sys.path.insert(0, _HERE)                                 # tagger / mapping
sys.path.insert(0, os.path.join(_REPO, "sdk", "python"))  # atlas_plugin_sdk

from atlas_plugin_sdk import Plugin  # noqa: E402
from mapping import CLASS_TO_DANBOORU  # noqa: E402
from tagger import JoyTagTagger  # noqa: E402

DEVICE = os.environ.get("ATLAS_DEVICE") or None
DEFAULT_THRESHOLD = 0.4  # JoyTag's balanced-F1 operating point
RAW_TAGS_LIMIT = 10

_lock = threading.Lock()
_tagger: JoyTagTagger | None = None


def _get_tagger() -> JoyTagTagger:
    global _tagger
    with _lock:
        if _tagger is None:
            _tagger = JoyTagTagger(device=DEVICE)
        return _tagger


# Load the model off the request path so the first node call doesn't eat the
# weight-loading time (capabilities/health stay instant either way).
threading.Thread(target=_get_tagger, daemon=True).start()


plugin = Plugin("joytag")
plugin.declare(
    "node",
    type="joytag",
    label="JoyTag",
    description="Propose tags with the JoyTag teacher model (Danbooru vocabulary mapped to the taxonomy)",
    method="node.tag",
    accepts={"status": "pending"},
    emits={"annotation": "tag"},
    # The tagger reads one still per ref, so a temporal span is not something it can
    # answer for; a clip project never sees this node in the designer.
    content_kinds=["image"],
    batch=8,
    params=[{"key": "threshold", "kind": "number", "label": "Threshold",
             "default": DEFAULT_THRESHOLD, "min": 0, "max": 1, "step": 0.05}],
)


def _class_probabilities(tag_probs: dict[str, float], classes: list[str]) -> dict[str, float]:
    """Max-pool Danbooru tag probabilities into the session's taxonomy classes."""
    out: dict[str, float] = {}
    for cls in classes:
        danbooru_tags = CLASS_TO_DANBOORU.get(cls)
        if not danbooru_tags:
            continue
        probability = max((tag_probs.get(tag, 0.0) for tag in danbooru_tags), default=0.0)
        if probability > 0.0:
            out[cls] = probability
    return out


def _top_raw_tags(tag_probs: dict[str, float], threshold: float) -> dict[str, float]:
    above = [(tag, prob) for tag, prob in tag_probs.items() if prob >= threshold]
    above.sort(key=lambda pair: pair[1], reverse=True)
    return {tag: round(prob, 3) for tag, prob in above[:RAW_TAGS_LIMIT]}


@plugin.method("node.tag")
def node_tag(items, params=None, project=None, classes=None):
    threshold = float((params or {}).get("threshold", DEFAULT_THRESHOLD))
    refs = [item["ref"] for item in items if item.get("ref")]
    tagger = _get_tagger()
    probabilities = tagger.predict_refs(refs)

    out = []
    for ref, row in zip(refs, probabilities):
        tag_probs = {tag: float(prob) for tag, prob in zip(tagger.tags, row)}
        class_probs = _class_probabilities(tag_probs, classes or [])
        labels = [cls for cls, prob in class_probs.items() if prob >= threshold]
        # Always emit annotations (possibly empty) so Save clears stale proposals.
        # The raw joytag field is for downstream nodes / notify templates only.
        out.append({
            "ref": ref,
            "annotations": [{"type": "tag", "value": {"labels": labels}}],
            "joytag": _top_raw_tags(tag_probs, threshold),
        })
    return {"items": out}


app = plugin.app()

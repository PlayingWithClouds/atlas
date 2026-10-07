"""Tests for clustering and label propagation in the model plugin.

Run with the model plugin venv:  plugins/model/.venv/bin/python tests/test_cluster.py
"""

import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "plugins", "model"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "sdk", "python"))

import main  # noqa: E402

LEFT = np.array([1.0, 0.0], dtype=np.float32)
NEAR_LEFT = np.array([0.99, 0.14], dtype=np.float32)
RIGHT = np.array([0.0, 1.0], dtype=np.float32)


def with_vectors(vectors: dict) -> None:
    """Answer from fixed vectors instead of loading a backbone."""
    main._ensure_vectors = lambda project, refs: None
    main._vector = lambda project, ref: vectors.get(ref)


def tag(*labels):
    return {"type": "tag", "value": {"labels": list(labels)}}


def test_cluster_keeps_groups_of_one():
    with_vectors({"a": LEFT, "b": NEAR_LEFT, "c": RIGHT})
    groups = main.cluster(["a", "b", "c"], 0.9)["clusters"]
    assert [group["members"] for group in groups] == [["a", "b"], ["c"]]
    assert [group["keep"] for group in groups] == ["a", "c"]


def test_duplicates_still_reports_only_real_duplicates():
    # duplicates() is layered on cluster() now; a lone entity must not become a dupe.
    with_vectors({"a": LEFT, "b": NEAR_LEFT, "c": RIGHT})
    result = main.duplicates(["a", "b", "c"], 0.9)
    assert result["duplicates"] == ["b"]
    assert result["count"] == 1
    assert result["clusters"] == [{"keep": "a", "dupes": ["b"]}]


def test_cluster_ignores_unembeddable_refs():
    with_vectors({"a": LEFT})
    groups = main.cluster(["a", "missing"], 0.9)["clusters"]
    assert [group["members"] for group in groups] == [["a"]]


def test_node_cluster_marks_one_representative():
    with_vectors({"a": LEFT, "b": NEAR_LEFT, "c": RIGHT})
    items = [{"ref": ref} for ref in ("a", "b", "c")]
    out = main.node_cluster(items, {"threshold": 0.9})["items"]
    by_ref = {item["ref"]: item for item in out}
    assert by_ref["a"]["cluster"] == by_ref["b"]["cluster"]
    assert by_ref["c"]["cluster"] != by_ref["a"]["cluster"]
    assert [by_ref[ref]["representative"] for ref in ("a", "b", "c")] == [True, False, True]


def test_propagate_copies_labels_to_similar_entities():
    with_vectors({"labeled": LEFT, "same": NEAR_LEFT, "different": RIGHT})
    items = [
        {"ref": "labeled", "status": "labeled", "annotations": [tag("blowjob")]},
        {"ref": "same", "status": "pending"},
        {"ref": "different", "status": "pending"},
    ]
    out = main.node_propagate(items, {"threshold": 0.9})["items"]
    by_ref = {item["ref"]: item for item in out}
    assert by_ref["same"]["annotations"] == [tag("blowjob")]
    # Below the threshold nothing is written — and crucially no empty annotation list,
    # which a Save node would apply as "clear whatever was proposed here".
    assert "annotations" not in by_ref["different"]


def test_propagate_without_a_labeled_peer_says_so():
    with_vectors({"a": LEFT, "b": NEAR_LEFT})
    result = main.node_propagate([{"ref": "a", "status": "pending"},
                                  {"ref": "b", "status": "pending"}], {})
    assert len(result["items"]) == 2
    assert "no labeled entities" in result["message"]


if __name__ == "__main__":
    test_cluster_keeps_groups_of_one()
    test_duplicates_still_reports_only_real_duplicates()
    test_cluster_ignores_unembeddable_refs()
    test_node_cluster_marks_one_representative()
    test_propagate_copies_labels_to_similar_entities()
    test_propagate_without_a_labeled_peer_says_so()
    print("test_cluster OK")

"""Tests for the adjacent-similarity chain scene segmentation merges clips with.

Run with the model plugin venv:  plugins/model/.venv/bin/python tests/test_similarity.py
"""

import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "plugins", "model"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "sdk", "python"))

import main  # noqa: E402

LEFT = np.array([1.0, 0.0], dtype=np.float32)
RIGHT = np.array([0.0, 1.0], dtype=np.float32)
HALFWAY = np.array([1.0, 1.0], dtype=np.float32)


def with_vectors(vectors: dict) -> None:
    """Answer from fixed vectors instead of loading a backbone."""
    main._ensure_vectors = lambda project, refs: None
    main._vector = lambda project, ref: vectors.get(ref)


def test_scores_each_adjacent_pair():
    with_vectors({"a": LEFT, "b": LEFT, "c": RIGHT})
    # One score fewer than refs: a~b are the same content, b~c are not.
    assert main.similarity(["a", "b", "c"])["scores"] == [1.0, 0.0]


def test_scores_are_cosine_not_dot():
    with_vectors({"a": LEFT, "b": HALFWAY})
    assert main.similarity(["a", "b"])["scores"] == [round(1 / np.sqrt(2), 4)]


def test_unembeddable_ref_scores_zero_both_sides():
    # A clip that failed to decode must not read as similar to its neighbours, or the
    # boundaries around it would be merged away.
    with_vectors({"a": LEFT, "c": LEFT})
    assert main.similarity(["a", "b", "c"])["scores"] == [0.0, 0.0]


def test_too_few_refs_have_no_pairs():
    with_vectors({"a": LEFT})
    assert main.similarity(["a"])["scores"] == []
    assert main.similarity([])["scores"] == []


if __name__ == "__main__":
    test_scores_each_adjacent_pair()
    test_scores_are_cosine_not_dot()
    test_unembeddable_ref_scores_zero_both_sides()
    test_too_few_refs_have_no_pairs()
    print("test_similarity OK")

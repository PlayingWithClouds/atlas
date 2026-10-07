"""Tests for pool removal — the bookkeeping a trimmed temporal span depends on.

Run with the model plugin venv:  plugins/model/.venv/bin/python tests/test_pool.py
"""

import os
import shutil
import sys
import tempfile

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "plugins", "model"))

from trainset import GlobalTrainSet  # noqa: E402


def make_pool(directory: str) -> GlobalTrainSet:
    return GlobalTrainSet("test", 4, dir=directory)


def vector(seed: float) -> np.ndarray:
    return np.full((4,), seed, dtype=np.float32)


def test_remove_drops_rows_and_persists():
    directory = tempfile.mkdtemp()
    try:
        pool = make_pool(directory)
        pool.upsert_many([
            ("a.mp4#t=0.000,4.000", vector(1), ["blowjob"]),
            ("a.mp4#t=4.000,8.000", vector(2), ["vaginal"]),
            ("a.mp4#t=8.000,12.000", vector(3), ["anal"]),
        ])
        assert pool.count() == 3

        removed = pool.remove(["a.mp4#t=4.000,8.000"])
        assert removed == 1
        assert pool.count() == 2
        assert "a.mp4#t=4.000,8.000" not in pool.index_by_ref
        # Surviving rows keep their vectors aligned with their refs.
        for ref, expected in [("a.mp4#t=0.000,4.000", 1), ("a.mp4#t=8.000,12.000", 3)]:
            assert pool.vectors[pool.index_by_ref[ref]][0] == expected

        # The removal survives a reload — the pool is what trains the head.
        reloaded = make_pool(directory)
        assert reloaded.count() == 2
        assert "a.mp4#t=4.000,8.000" not in reloaded.index_by_ref
    finally:
        shutil.rmtree(directory)


def test_remove_ignores_unknown_refs():
    directory = tempfile.mkdtemp()
    try:
        pool = make_pool(directory)
        pool.upsert("a.mp4#t=0.000,4.000", vector(1), ["solo"])
        assert pool.remove(["nope"]) == 0
        assert pool.remove([]) == 0
        assert pool.count() == 1
    finally:
        shutil.rmtree(directory)


def test_trimmed_span_does_not_grow_the_pool():
    """A trim is remove(old) + upsert(new): one example in, one out."""
    directory = tempfile.mkdtemp()
    try:
        pool = make_pool(directory)
        pool.upsert("a.mp4#t=0.000,4.000", vector(1), ["blowjob"])
        pool.remove(["a.mp4#t=0.000,4.000"])
        pool.upsert("a.mp4#t=1.500,5.500", vector(9), ["blowjob"])
        assert pool.count() == 1
        assert pool.refs == ["a.mp4#t=1.500,5.500"]
    finally:
        shutil.rmtree(directory)


if __name__ == "__main__":
    test_remove_drops_rows_and_persists()
    test_remove_ignores_unknown_refs()
    test_trimmed_span_does_not_grow_the_pool()
    print("test_pool OK")

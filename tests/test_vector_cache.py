"""Tests for the unlabeled-vector cache.

The backend marks an entity `embedded` in its own database as soon as the plugin reports
a vector. These vectors used to live in memory only, so a plugin restart made that flag a
lie and every later predict re-embedded from scratch — minutes of ffmpeg for one video
session, which stalled the whole plugin.

Run with the model plugin venv:  plugins/model/.venv/bin/python tests/test_vector_cache.py
"""

import os
import shutil
import sys
import tempfile

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "plugins", "model"))

from trainset import VectorCache  # noqa: E402


def vector(seed: float) -> np.ndarray:
    return np.full((4,), seed, dtype=np.float32)


def make_cache(directory: str, model_name: str = "siglip", capacity: int = 100) -> VectorCache:
    # flush_seconds=0 keeps the debounce out of the tests; every test flushes explicitly.
    return VectorCache(model_name, 4, dir=directory, capacity=capacity, flush_seconds=0)


def test_vectors_survive_a_restart():
    directory = tempfile.mkdtemp()
    try:
        cache = make_cache(directory)
        cache.put({"a.mp4#t=0.000,4.000": vector(1), "a.mp4#t=4.000,8.000": vector(2)})
        cache.flush()

        reloaded = make_cache(directory)
        assert sorted(reloaded.vectors) == ["a.mp4#t=0.000,4.000", "a.mp4#t=4.000,8.000"]
        assert reloaded.get("a.mp4#t=0.000,4.000")[0] == 1
        assert reloaded.get("a.mp4#t=4.000,8.000")[0] == 2
        assert reloaded.get("missing") is None
    finally:
        shutil.rmtree(directory)


def test_other_backbone_cache_is_ignored():
    """Vectors from a different backbone live in a different space; reusing them would
    silently feed garbage to the head."""
    directory = tempfile.mkdtemp()
    try:
        cache = make_cache(directory, model_name="siglip")
        cache.put({"a.jpg": vector(1)})
        cache.flush()

        assert len(make_cache(directory, model_name="joytag").vectors) == 0
    finally:
        shutil.rmtree(directory)


def test_capacity_evicts_oldest_first():
    directory = tempfile.mkdtemp()
    try:
        cache = make_cache(directory, capacity=2)
        cache.put({"first": vector(1)})
        cache.put({"second": vector(2)})
        cache.put({"third": vector(3)})
        assert sorted(cache.vectors) == ["second", "third"]

        cache.flush()
        assert sorted(make_cache(directory).vectors) == ["second", "third"]
    finally:
        shutil.rmtree(directory)


def test_drop_removes_refs():
    """A trimmed span gets a new ref; the old one must not keep answering as embedded."""
    directory = tempfile.mkdtemp()
    try:
        cache = make_cache(directory)
        cache.put({"a.mp4#t=0.000,4.000": vector(1), "a.mp4#t=4.000,8.000": vector(2)})
        cache.drop(["a.mp4#t=0.000,4.000", "never-present"])
        assert cache.get("a.mp4#t=0.000,4.000") is None
        assert cache.get("a.mp4#t=4.000,8.000") is not None

        cache.flush()
        assert sorted(make_cache(directory).vectors) == ["a.mp4#t=4.000,8.000"]
    finally:
        shutil.rmtree(directory)


def test_empty_cache_round_trips():
    directory = tempfile.mkdtemp()
    try:
        cache = make_cache(directory)
        cache.flush()
        assert len(make_cache(directory).vectors) == 0
    finally:
        shutil.rmtree(directory)


if __name__ == "__main__":
    test_vectors_survive_a_restart()
    test_other_backbone_cache_is_ignored()
    test_capacity_evicts_oldest_first()
    test_drop_removes_refs()
    test_empty_cache_round_trips()
    print("test_vector_cache OK")

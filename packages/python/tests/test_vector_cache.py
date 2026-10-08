import numpy as np

from atlas_ml.pool import VectorCache


def vector(seed: float) -> np.ndarray:
    return np.full((4,), seed, dtype=np.float32)


def make_cache(directory, encoder_id="enc", capacity=100, flush_seconds=0.0) -> VectorCache:
    return VectorCache(encoder_id, 4, str(directory), capacity=capacity,
                       flush_seconds=flush_seconds)


def test_vectors_survive_a_restart(tmp_path):
    cache = make_cache(tmp_path)
    cache.put({"a": vector(1), "b": vector(2)})
    cache.flush()

    reloaded = make_cache(tmp_path)
    assert sorted(reloaded.vectors) == ["a", "b"]
    assert reloaded.get("a")[0] == 1
    assert reloaded.get("missing") is None


def test_other_encoder_cache_is_ignored(tmp_path):
    cache = make_cache(tmp_path, encoder_id="first")
    cache.put({"a": vector(1)})
    cache.flush()
    assert len(make_cache(tmp_path, encoder_id="second").vectors) == 0


def test_capacity_evicts_oldest_first(tmp_path):
    cache = make_cache(tmp_path, capacity=2)
    cache.put({"first": vector(1)})
    cache.put({"second": vector(2)})
    cache.put({"third": vector(3)})
    assert sorted(cache.vectors) == ["second", "third"]
    cache.flush()
    assert sorted(make_cache(tmp_path).vectors) == ["second", "third"]


def test_drop_removes_refs(tmp_path):
    cache = make_cache(tmp_path)
    cache.put({"a": vector(1), "b": vector(2)})
    cache.drop(["a", "never-present"])
    assert cache.get("a") is None
    cache.flush()
    assert sorted(make_cache(tmp_path).vectors) == ["b"]


def test_empty_cache_round_trips(tmp_path):
    make_cache(tmp_path).flush()
    assert len(make_cache(tmp_path).vectors) == 0


def test_close_cancels_pending_timer_and_flushes(tmp_path):
    cache = make_cache(tmp_path, flush_seconds=3600)
    cache.put({"a": vector(1)})
    assert cache.flush_timer is not None
    cache.close()
    assert cache.flush_timer is None
    assert sorted(make_cache(tmp_path).vectors) == ["a"]
    cache.put({"b": vector(2)})
    assert cache.flush_timer is None

import numpy as np

from atlas_ml.pool import TrainPool, pool_directory


def make_pool(directory: str, encoder_id: str = "test", dim: int = 4) -> TrainPool:
    return TrainPool(encoder_id, dim, directory)


def vector(seed: float) -> np.ndarray:
    return np.full((4,), seed, dtype=np.float32)


def test_remove_drops_rows_and_persists(tmp_path):
    pool = make_pool(str(tmp_path))
    pool.upsert_many([
        ("a.mp4#t=0.000,4.000", vector(1), ["one"]),
        ("a.mp4#t=4.000,8.000", vector(2), ["two"]),
        ("a.mp4#t=8.000,12.000", vector(3), ["three"]),
    ])
    assert pool.remove(["a.mp4#t=4.000,8.000"]) == 1
    assert pool.count() == 2
    for ref, expected in [("a.mp4#t=0.000,4.000", 1), ("a.mp4#t=8.000,12.000", 3)]:
        assert pool.vectors[pool.index_by_ref[ref]][0] == expected

    reloaded = make_pool(str(tmp_path))
    assert reloaded.count() == 2
    assert "a.mp4#t=4.000,8.000" not in reloaded.index_by_ref


def test_remove_ignores_unknown_refs(tmp_path):
    pool = make_pool(str(tmp_path))
    pool.upsert("a", vector(1), ["solo"])
    assert pool.remove(["nope"]) == 0
    assert pool.remove([]) == 0
    assert pool.count() == 1


def test_trimmed_span_does_not_grow_the_pool(tmp_path):
    pool = make_pool(str(tmp_path))
    pool.upsert("a.mp4#t=0.000,4.000", vector(1), ["x"])
    pool.remove(["a.mp4#t=0.000,4.000"])
    pool.upsert("a.mp4#t=1.500,5.500", vector(9), ["x"])
    assert pool.refs == ["a.mp4#t=1.500,5.500"]


def test_upsert_replaces_existing_row(tmp_path):
    pool = make_pool(str(tmp_path))
    pool.upsert("a", vector(1), ["x"])
    pool.upsert("a", vector(2), ["y"])
    assert pool.count() == 1
    assert pool.labels == [["y"]]
    assert pool.vectors[0][0] == 2


def test_other_encoder_pool_starts_fresh(tmp_path):
    make_pool(str(tmp_path), encoder_id="first").upsert("a", vector(1), ["x"])
    assert make_pool(str(tmp_path), encoder_id="second").count() == 0
    assert make_pool(str(tmp_path), encoder_id="first").count() == 1


def test_other_dimension_pool_starts_fresh(tmp_path):
    make_pool(str(tmp_path), dim=4).upsert("a", vector(1), ["x"])
    assert make_pool(str(tmp_path), dim=8).count() == 0


def test_interrupted_write_trims_to_shortest_column(tmp_path):
    pool = make_pool(str(tmp_path))
    pool.upsert_many([("a", vector(1), ["x"]), ("b", vector(2), ["y"])])
    data = np.load(pool.data_path(), allow_pickle=True)
    np.savez(pool.data_path(), refs=data["refs"], labels=data["labels"],
             vectors=data["vectors"][:1])
    reloaded = make_pool(str(tmp_path))
    assert reloaded.refs == ["a"]
    assert reloaded.vectors.shape == (1, 4)


def test_matrix_builds_multi_hot_targets(tmp_path):
    pool = make_pool(str(tmp_path))
    pool.upsert_many([("a", vector(1), ["x", "y"]), ("b", vector(2), ["y", "ignored"])])
    _, targets = pool.matrix(["x", "y"])
    assert targets.tolist() == [[1, 1], [0, 1]]


def test_pool_directory_layout():
    assert pool_directory("/c", "enc", "proj") == "/c/enc/proj"

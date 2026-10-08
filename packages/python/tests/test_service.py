import numpy as np
import pytest

from atlas_ml.testing import FakeEncoder
from atlas_ml.service import ModelService
from conftest import descriptor

CLASSES = ["cat", "dog"]


def labeled(ref: str, *labels: str) -> dict:
    return {"ref": ref, "labels": list(labels)}


def separable_vectors(count: int) -> dict:
    """Half the refs point along x (cat), half along y (dog), with small jitter."""
    generator = np.random.RandomState(1)
    vectors = {}
    for index in range(count):
        base = np.array([1.0, 0.0]) if index % 2 == 0 else np.array([0.0, 1.0])
        vectors[f"r{index}"] = base + generator.normal(0, 0.05, 2)
    return vectors


def label_all(service, vectors):
    refs = list(vectors)
    service.embed("p", [descriptor(ref) for ref in refs])
    entries = [labeled(ref, "cat" if index % 2 == 0 else "dog") for index, ref in enumerate(refs)]
    service.train("p", entries, CLASSES)
    service.wait_idle()


def test_embed_skips_already_embedded_and_chunks(make_service):
    vectors = {f"r{index}": np.array([1.0, index]) for index in range(40)}
    service = make_service(vectors)
    refs = list(vectors)
    result = service.embed("p", [descriptor(ref) for ref in refs])
    assert result["embedded"] == refs
    assert [len(call) for call in service.encoder.embed_calls] == [16, 16, 8]

    service.embed("p", [descriptor(ref) for ref in refs])
    assert len(service.encoder.embed_calls) == 3


def test_embed_omits_undecodable_items(make_service):
    service = make_service({"a": np.array([1.0, 0.0])})
    result = service.embed("p", [descriptor("a"), descriptor("broken")])
    assert result["embedded"] == ["a"]


def test_embed_raises_when_encoder_fails_everywhere(make_service):
    service = make_service({})
    service.encoder.embed = lambda items: (_ for _ in ()).throw(RuntimeError("boom"))
    with pytest.raises(RuntimeError):
        service.embed("p", [descriptor("a")])


def test_train_needs_four_labels_to_fit(make_service):
    vectors = separable_vectors(3)
    service = make_service(vectors)
    label_all(service, vectors)
    assert service.status("p", CLASSES) == {"poolSize": 3, "trained": False}
    assert service.rank("p", list(vectors), CLASSES)["trained"] is False


def test_predict_returns_stale_head_without_blocking(make_service):
    vectors = separable_vectors(12)
    service = make_service(vectors)
    label_all(service, vectors)
    first = service.predict("p", ["r0", "r1"], CLASSES)
    assert first["r0"]["cat"] > first["r0"]["dog"]
    assert first["r1"]["dog"] > first["r1"]["cat"]

    service.train("p", [labeled("r0", "dog")], CLASSES)
    stale = service.predict("p", ["r0"], CLASSES)
    assert set(stale["r0"]) == set(CLASSES)
    service.wait_idle()


def test_predict_without_head_returns_empty_maps(make_service):
    service = make_service({"a": np.array([1.0, 0.0])})
    assert service.predict("p", ["a", "b"], CLASSES) == {"a": {}, "b": {}}


def test_rank_puts_unembedded_refs_last_in_input_order(make_service):
    vectors = separable_vectors(12)
    service = make_service(vectors)
    label_all(service, vectors)
    service.encoder.vectors["ambiguous"] = np.array([1.0, 1.0])
    service.embed("p", [descriptor("ambiguous")])

    refs = ["unknown2", "r0", "ambiguous", "unknown1", "r1"]
    result = service.rank("p", refs, CLASSES)
    assert result["trained"] is True
    assert result["order"][0] == "ambiguous"
    assert result["order"][-2:] == ["unknown2", "unknown1"]
    assert sorted(result["order"]) == sorted(refs)


def test_rank_never_embeds(make_service):
    service = make_service({"a": np.array([1.0, 0.0])})
    service.rank("p", ["a"], CLASSES)
    assert service.encoder.embed_calls == []


def test_forget_removes_pool_rows_and_cache_vectors(make_service):
    vectors = separable_vectors(6)
    service = make_service(vectors)
    label_all(service, vectors)
    service.forget("p", ["r0", "r1"])
    assert service.status("p", CLASSES)["poolSize"] == 4
    assert service.embed("p", [descriptor("r0")])["embedded"] == ["r0"]
    assert [call for call in service.encoder.embed_calls if call == ["r0"]] != []


def test_pool_dump_lists_labels(make_service):
    vectors = separable_vectors(2)
    service = make_service(vectors)
    label_all(service, vectors)
    assert service.pool_dump("p") == [{"ref": "r0", "labels": ["cat"]},
                                      {"ref": "r1", "labels": ["dog"]}]


def test_search_requires_text_capability(make_service):
    service = make_service({"a": np.array([1.0, 0.0])})
    with pytest.raises(ValueError, match="text search"):
        service.search("p", "query", ["a"], 5)


def test_search_ranks_by_text_similarity(cache_root):
    encoder = FakeEncoder()
    service = ModelService(encoder, cache_root)
    refs = ["alpha", "beta", "gamma"]
    service.embed("p", [descriptor(ref) for ref in refs])
    results = service.search("p", "beta", refs + ["unembedded"], 2)
    assert results[0]["ref"] == "beta"
    assert len(results) == 2
    service.close()


def test_insights_dedupe_before_folding(make_service):
    """Every vector is repeated 6 times with the same label, and the labels are random
    relative to the vectors. Without dedupe, copies leak across folds and the model looks
    perfect; with dedupe the score stays near the base rate."""
    generator = np.random.RandomState(7)
    vectors = {}
    entries = []
    for group in range(24):
        vector = generator.normal(0, 1, 16)
        label = "cat" if generator.rand() < 0.5 else "dog"
        for copy in range(6):
            ref = f"g{group}c{copy}"
            vectors[ref] = vector
            entries.append(labeled(ref, label))
    service = make_service(vectors, dim=16)
    service.embed("p", [descriptor(ref) for ref in vectors])
    service.train("p", entries, CLASSES)
    service.wait_idle()

    report = service.insights("p", CLASSES)
    assert report["poolSize"] == 144
    cat = next(entry for entry in report["classes"] if entry["name"] == "cat")
    assert cat["evaluated"] is True
    assert cat["support"] + cat["negatives"] == 24
    assert cat["averagePrecision"] < 0.85


def test_insights_marks_small_classes_unevaluated(make_service):
    vectors = separable_vectors(10)
    service = make_service(vectors)
    label_all(service, vectors)
    service.train("p", [labeled("r0", "cat", "rare")], CLASSES + ["rare"])
    report = service.insights("p", ["cat", "dog", "rare"])
    rare = next(entry for entry in report["classes"] if entry["name"] == "rare")
    assert rare["evaluated"] is False


def test_insights_empty_pool(make_service):
    service = make_service({})
    assert service.insights("p", CLASSES) == {"poolSize": 0, "classes": []}

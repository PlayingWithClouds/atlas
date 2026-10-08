"""Cluster, duplicates and similarity through the service."""

import numpy as np

from conftest import descriptor

LEFT = np.array([1.0, 0.0])
NEAR_LEFT = np.array([0.99, 0.14])
RIGHT = np.array([0.0, 1.0])
HALFWAY = np.array([1.0, 1.0])


def embed_all(service, refs):
    service.embed("p", [descriptor(ref) for ref in refs])


def test_cluster_keeps_groups_of_one(make_service):
    service = make_service({"a": LEFT, "b": NEAR_LEFT, "c": RIGHT})
    embed_all(service, ["a", "b", "c"])
    groups = service.cluster("p", ["a", "b", "c"], 0.9)
    assert [group["members"] for group in groups] == [["a", "b"], ["c"]]
    assert [group["keep"] for group in groups] == ["a", "c"]


def test_duplicates_reports_only_real_duplicates(make_service):
    service = make_service({"a": LEFT, "b": NEAR_LEFT, "c": RIGHT})
    embed_all(service, ["a", "b", "c"])
    assert service.duplicates("p", ["a", "b", "c"], 0.9) == [{"keep": "a", "duplicates": ["b"]}]


def test_cluster_ignores_unembedded_refs(make_service):
    service = make_service({"a": LEFT})
    embed_all(service, ["a"])
    groups = service.cluster("p", ["a", "missing"], 0.9)
    assert [group["members"] for group in groups] == [["a"]]


def test_cluster_never_embeds(make_service):
    service = make_service({"a": LEFT})
    service.cluster("p", ["a"], 0.9)
    assert service.encoder.embed_calls == []


def test_similarity_scores_each_adjacent_pair(make_service):
    service = make_service({"a": LEFT, "b": LEFT, "c": RIGHT})
    embed_all(service, ["a", "b", "c"])
    assert service.similarity("p", ["a", "b", "c"]) == [1.0, 0.0]


def test_similarity_is_cosine_not_dot(make_service):
    service = make_service({"a": LEFT, "b": HALFWAY})
    embed_all(service, ["a", "b"])
    assert service.similarity("p", ["a", "b"]) == [round(1 / np.sqrt(2), 4)]


def test_missing_ref_scores_zero_on_both_sides(make_service):
    service = make_service({"a": LEFT, "c": LEFT})
    embed_all(service, ["a", "c"])
    assert service.similarity("p", ["a", "b", "c"]) == [0.0, 0.0]


def test_too_few_refs_have_no_pairs(make_service):
    service = make_service({"a": LEFT})
    assert service.similarity("p", ["a"]) == []
    assert service.similarity("p", []) == []

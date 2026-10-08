"""Spawns the stdio worker in tagger mode with a fake tagger module."""

import os

import pytest

from test_worker import WorkerProcess, image

TESTS_DIRECTORY = os.path.dirname(__file__)


@pytest.fixture
def tagger_worker(tmp_path):
    process = WorkerProcess(str(tmp_path), module="fake_tagger", extra_paths=(TESTS_DIRECTORY,))
    yield process
    if process.process.poll() is None:
        process.process.kill()


def test_describe_reports_a_tagger(tagger_worker):
    assert tagger_worker.call("describe")["result"] == {
        "id": "fake-tagger", "mediaKinds": ["image"], "kind": "tagger",
    }


def test_tag_returns_one_score_dict_per_item(tagger_worker):
    items = [image("a"), image("broken")]
    result = tagger_worker.call("tag", {"items": items})["result"]
    assert result[0] == {"cat": 0.9123, "dog": 0.2, "ref_length": 0.01}
    assert result[1] == {}


def test_tag_drops_scores_below_min_score(tagger_worker):
    result = tagger_worker.call("tag", {"items": [image("a")], "minScore": 0.5})["result"]
    assert result == [{"cat": 0.9123}]


def test_encoder_methods_are_not_served_by_a_tagger(tagger_worker):
    assert tagger_worker.call("embed", {"projectId": "p", "items": []})["error"]["code"] == -32601


def test_exits_cleanly_on_stdin_eof(tagger_worker):
    tagger_worker.call("ping")
    assert tagger_worker.close() == 0

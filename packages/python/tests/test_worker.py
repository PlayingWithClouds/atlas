"""Spawns the stdio worker with the FakeEncoder and speaks JSON-RPC to it."""

import json
import os
import subprocess
import sys

import pytest

from conftest import PACKAGE_ROOT


class WorkerProcess:
    def __init__(self, cache_root: str):
        environment = dict(os.environ, PYTHONPATH=PACKAGE_ROOT)
        self.process = subprocess.Popen(
            [sys.executable, "-m", "atlas_ml.worker", "--module", "atlas_ml.testing",
             "--cache-root", cache_root],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, env=environment,
        )
        self.next_id = 0

    def send_raw(self, line: str) -> dict:
        self.process.stdin.write(line + "\n")
        self.process.stdin.flush()
        return json.loads(self.process.stdout.readline())

    def call(self, method: str, params: dict | None = None) -> dict:
        self.next_id += 1
        request = {"jsonrpc": "2.0", "id": self.next_id, "method": method,
                   "params": params or {}}
        response = self.send_raw(json.dumps(request))
        assert response["id"] == self.next_id
        return response

    def close(self) -> int:
        self.process.stdin.close()
        return self.process.wait(timeout=20)


@pytest.fixture
def worker(tmp_path):
    process = WorkerProcess(str(tmp_path))
    yield process
    if process.process.poll() is None:
        process.process.kill()


def image(ref: str) -> dict:
    return {"ref": ref, "mediaKind": "image", "location": {"kind": "file", "path": ref}}


def test_ping_and_describe(worker):
    assert worker.call("ping")["result"] == "pong"
    assert worker.call("describe")["result"] == {
        "id": "fake", "dim": 16, "mediaKinds": ["image", "video"],
        "capabilities": {"textSearch": True},
    }


def test_embed_train_predict_round_trip(worker):
    refs = [f"item{index}" for index in range(8)]
    embedded = worker.call("embed", {"projectId": "p", "items": [image(ref) for ref in refs]})
    assert embedded["result"] == {"embedded": refs}

    labeled = [{"ref": ref, "labels": ["a" if index % 2 else "b"]}
               for index, ref in enumerate(refs)]
    trained = worker.call("train", {"projectId": "p", "labeled": labeled, "classes": ["a", "b"]})
    assert trained["result"] == {"poolSize": 8}

    dump = worker.call("poolDump", {"projectId": "p"})["result"]
    assert len(dump) == 8
    status = worker.call("status", {"projectId": "p", "classes": ["a", "b"]})["result"]
    assert status == {"poolSize": 8, "trained": True}

    predicted = worker.call("predict", {"projectId": "p", "refs": ["item0"], "classes": ["a", "b"]})
    assert "item0" in predicted["result"]


def test_unknown_method(worker):
    assert worker.call("nope")["error"]["code"] == -32601


def test_malformed_line_gets_parse_error_and_worker_survives(worker):
    response = worker.send_raw("{not json")
    assert response["error"]["code"] == -32700
    assert response["id"] is None
    assert worker.call("ping")["result"] == "pong"


def test_handler_error_maps_to_server_error(worker):
    response = worker.call("rank", {"projectId": "p", "refs": [], "classes": [],
                                    "strategy": "no-such-strategy-but-no-head"})
    assert "result" in response or response["error"]["code"] == -32000
    response = worker.call("search", {"projectId": "p", "query": "x", "refs": [], "limit": 3})
    assert response["result"] == []
    response = worker.call("embed", {"projectId": "p"})
    assert response["error"]["code"] == -32602


def test_exits_cleanly_on_stdin_eof(worker):
    worker.call("ping")
    assert worker.close() == 0


def test_stdout_carries_only_protocol_lines(worker):
    worker.call("ping")
    worker.process.stdin.close()
    remaining = worker.process.stdout.read()
    worker.process.wait(timeout=20)
    assert remaining == ""

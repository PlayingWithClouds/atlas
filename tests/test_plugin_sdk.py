"""Tests that a slow plugin method cannot take the plugin down.

Model methods block for seconds to minutes (ffmpeg, GPU). Run on the event loop they
starve every other request, /health included — and a health probe that stays silent long
enough gets the process killed by the supervisor, which is exactly how a video session
lost its model mid-labeling.

Run with the model plugin venv:  plugins/model/.venv/bin/python tests/test_plugin_sdk.py
"""

import json
import os
import socket
import sys
import threading
import time
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "sdk", "python"))

import uvicorn  # noqa: E402
from atlas_plugin_sdk import Plugin  # noqa: E402

BLOCK_SECONDS = 2.0

plugin = Plugin("test-plugin")
plugin.declare("model", annotation_types=["tag"])


@plugin.method("slow")
def slow():
    time.sleep(BLOCK_SECONDS)
    return {"done": True}


@plugin.method("echo")
def echo(value=None):
    return {"value": value}


@plugin.method("boom")
def boom():
    raise RuntimeError("handler exploded")


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def rpc(port: int, method: str, params=None, timeout: float = 30):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method,
                       "params": params or {}}).encode()
    request = urllib.request.Request(f"http://127.0.0.1:{port}/rpc", data=body,
                                     headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read())


def health(port: int, timeout: float = 5) -> float:
    started = time.time()
    urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=timeout).read()
    return time.time() - started


def serve() -> int:
    port = free_port()
    server = uvicorn.Server(uvicorn.Config(plugin.app(), host="127.0.0.1", port=port,
                                           log_level="error"))
    threading.Thread(target=server.run, daemon=True).start()
    for _ in range(100):
        try:
            health(port, timeout=1)
            return port
        except Exception:
            time.sleep(0.1)
    raise RuntimeError("plugin did not come up")


def test_a_blocking_method_does_not_stall_the_plugin():
    port = serve()
    blocked = threading.Thread(target=lambda: rpc(port, "slow"))
    blocked.start()
    time.sleep(0.3)  # let the slow call take hold

    # Both must answer while the slow handler is still sleeping.
    assert health(port) < 1.0
    assert rpc(port, "echo", {"value": 7})["result"] == {"value": 7}
    assert blocked.is_alive(), "the slow method finished too early to prove anything"

    blocked.join()


def test_capabilities_and_errors_still_work():
    port = serve()
    capabilities = rpc(port, "capabilities")["result"]
    assert capabilities["plugin"] == "test-plugin"
    assert [entry["name"] for entry in capabilities["capabilities"]] == ["model"]

    assert rpc(port, "nope")["error"]["code"] == -32601
    assert rpc(port, "boom")["error"]["message"] == "handler exploded"


if __name__ == "__main__":
    test_a_blocking_method_does_not_stall_the_plugin()
    test_capabilities_and_errors_still_work()
    print("test_plugin_sdk OK")

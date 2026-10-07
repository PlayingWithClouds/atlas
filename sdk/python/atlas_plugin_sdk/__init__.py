"""Atlas plugin SDK (Python) — write a plugin as a JSON-RPC 2.0 HTTP service.

A plugin is a FastAPI app exposing a single POST /rpc endpoint. This helper handles
the envelope + the mandatory `capabilities()` handshake, so a plugin is just a set of
methods plus its declared capabilities:

    from atlas_plugin_sdk import Plugin

    plugin = Plugin("model")
    plugin.declare("model", annotation_types=["tag"], singleton=True)

    @plugin.method("status")
    def status(classes=None, project="default"):
        return {"trained": False}

    app = plugin.app()   # uvicorn plugins.model.main:app --port 9301

Methods receive the RPC `params` as keyword arguments and return a JSON-serializable
result. Raising an exception becomes a JSON-RPC error reply.

Handlers may be plain `def` (run on a worker thread) or `async def` (awaited on the
event loop). Plain ones are the norm: model work blocks for seconds to minutes, and
running it on the loop would stall every other request, /health included.

This is the wire-compatible peer of the TypeScript SDK in `sdk/ts`.
"""

import inspect
from typing import Callable

from fastapi import FastAPI, Request
from starlette.concurrency import run_in_threadpool


class Plugin:
    def __init__(self, name: str):
        self.name = name
        self._methods: dict[str, Callable] = {}
        self._capabilities: list[dict] = []

    def declare(self, capability: str, **info) -> None:
        """Advertise a capability (name + arbitrary descriptor fields)."""
        self._capabilities.append({"name": capability, **info})

    def method(self, rpc_name: str) -> Callable:
        """Register a handler for an RPC method name."""

        def decorator(fn: Callable) -> Callable:
            self._methods[rpc_name] = fn
            return fn

        return decorator

    def app(self) -> FastAPI:
        api = FastAPI(title=f"{self.name} plugin")
        name = self.name
        methods = self._methods
        capabilities = self._capabilities

        @api.post("/rpc")
        async def rpc_endpoint(request: Request):
            body = await request.json()
            rpc_id = body.get("id")
            rpc_method = body.get("method")
            params = body.get("params") or {}

            if rpc_method == "capabilities":
                return {
                    "jsonrpc": "2.0",
                    "id": rpc_id,
                    "result": {"plugin": name, "capabilities": capabilities},
                }

            fn = methods.get(rpc_method)
            if fn is None:
                return {
                    "jsonrpc": "2.0",
                    "id": rpc_id,
                    "error": {"code": -32601, "message": f"method not found: {rpc_method}"},
                }

            try:
                result = await _invoke(fn, params)
                return {"jsonrpc": "2.0", "id": rpc_id, "result": result}
            except Exception as error:
                return {
                    "jsonrpc": "2.0",
                    "id": rpc_id,
                    "error": {"code": -32000, "message": str(error)},
                }

        @api.get("/health")
        def health():
            return {"ok": True, "plugin": name}

        return api


async def _invoke(fn: Callable, params):
    """Call a handler without ever blocking the event loop.

    A sync handler goes to a worker thread: embedding a batch of clips holds the CPU
    for minutes, and on the loop that would stall /health long enough for the process
    supervisor to declare the plugin dead and kill it.
    """
    if inspect.iscoroutinefunction(fn):
        if isinstance(params, dict):
            return await fn(**params)
        return await fn(*params)
    if isinstance(params, dict):
        return await run_in_threadpool(lambda: fn(**params))
    return await run_in_threadpool(lambda: fn(*params))

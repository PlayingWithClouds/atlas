"""JSON-RPC 2.0 worker over stdio.

    python -m atlas_ml.worker --module <module> [--cache-root DIR] [--device auto|cpu|cuda]

The module must expose `create_encoder(device: str) -> Encoder` (the full model service) or
`create_tagger(device: str) -> Tagger` (serves only `tag`). One JSON object per line
on stdin, one response per line on stdout. Everything else (logging included) goes to
stderr, because stdout is the protocol channel.
"""

import argparse
import importlib
import json
import os
import re
import sys
import threading
from concurrent.futures import ThreadPoolExecutor

from atlas_ml.log import log
from atlas_ml.service import ModelService
from atlas_ml.tagger import TaggerService

PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
SERVER_ERROR = -32000

SERVICE_METHODS = {
    "embed", "forget", "train", "predict", "rank", "duplicates", "cluster",
    "similarity", "search", "insights", "status", "poolDump",
}
TAGGER_METHODS = {"tag"}
# Long calls get their own pool so a backlog of embeds cannot starve status/rank/search.
HEAVY_METHODS = {"embed", "insights", "tag"}
HEAVY_THREADS = 8
LIGHT_THREADS = 8


class RpcError(Exception):
    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def snake_case(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


def to_json_value(value):
    """Fallback serializer for numpy scalars and arrays."""
    if hasattr(value, "tolist"):
        return value.tolist()
    raise TypeError(f"{type(value).__name__} is not JSON serializable")


class Worker:
    def __init__(self, module_name: str, cache_root: str, device: str):
        self.module_name = module_name
        self.cache_root = cache_root
        self.device = device
        self.service: ModelService | TaggerService | None = None
        self.load_error: Exception | None = None
        self.ready = threading.Event()
        self.output_lock = threading.Lock()
        self.heavy_executor = ThreadPoolExecutor(max_workers=HEAVY_THREADS)
        self.light_executor = ThreadPoolExecutor(max_workers=LIGHT_THREADS)

    # --- startup ----------------------------------------------------------------------

    def start_loading(self) -> None:
        threading.Thread(target=self.load_service, daemon=True).start()

    def load_service(self) -> None:
        try:
            module = importlib.import_module(self.module_name)
            self.service = self.build_service(module)
        except Exception as error:
            log(f"failed to load module {self.module_name}: {error}")
            self.load_error = error
        finally:
            self.ready.set()

    def build_service(self, module) -> ModelService | TaggerService:
        if hasattr(module, "create_tagger"):
            return TaggerService(module.create_tagger(self.device))
        encoder = module.create_encoder(self.device)
        return ModelService(encoder, self.cache_root, device=self.device)

    def loaded_service(self) -> ModelService | TaggerService:
        self.ready.wait()
        if self.service is None:
            raise RpcError(SERVER_ERROR, f"module failed to load: {self.load_error}")
        return self.service

    # --- dispatch ---------------------------------------------------------------------

    def describe(self) -> dict:
        service = self.loaded_service()
        if isinstance(service, TaggerService):
            return service.describe()
        encoder = service.encoder
        return {
            "id": encoder.id,
            "dim": encoder.dim,
            "mediaKinds": list(encoder.media_kinds),
            "capabilities": {"textSearch": hasattr(encoder, "embed_text")},
        }

    def dispatch(self, method: str, params: dict):
        if method == "ping":
            return "pong"
        if method == "describe":
            return self.describe()
        service = self.loaded_service()
        served = TAGGER_METHODS if isinstance(service, TaggerService) else SERVICE_METHODS
        if method not in served:
            raise RpcError(METHOD_NOT_FOUND, f"method not found: {method}")
        handler = getattr(service, snake_case(method))
        arguments = {snake_case(name): value for name, value in params.items()}
        try:
            return handler(**arguments)
        except TypeError as error:
            raise RpcError(INVALID_PARAMS, f"invalid params for {method}: {error}")

    def build_response(self, request: dict) -> dict | None:
        request_id = request.get("id")
        try:
            params = request.get("params") or {}
            if not isinstance(params, dict):
                raise RpcError(INVALID_PARAMS, "params must be an object")
            result = self.dispatch(request["method"], params)
            return {"jsonrpc": "2.0", "id": request_id, "result": result}
        except RpcError as error:
            return self.error_response(request_id, error.code, error.message)
        except Exception as error:
            log(f"{request.get('method')} failed: {error!r}")
            return self.error_response(request_id, SERVER_ERROR, str(error))

    def error_response(self, request_id, code: int, message: str) -> dict:
        return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}

    def handle_request(self, request: dict) -> None:
        response = self.build_response(request)
        if "id" in request:
            self.write(response)

    def write(self, message: dict) -> None:
        line = json.dumps(message, default=to_json_value)
        with self.output_lock:
            sys.stdout.write(line + "\n")
            sys.stdout.flush()

    def handle_line(self, line: str) -> None:
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            self.write(self.error_response(None, PARSE_ERROR, "parse error"))
            return
        if not isinstance(request, dict) or "method" not in request:
            self.write(self.error_response(None, INVALID_REQUEST, "invalid request"))
            return
        self.executor_for(request["method"]).submit(self.handle_request, request)

    def executor_for(self, method: str) -> ThreadPoolExecutor:
        if method in HEAVY_METHODS:
            return self.heavy_executor
        return self.light_executor

    # --- lifecycle --------------------------------------------------------------------

    def serve(self) -> None:
        self.start_loading()
        for line in sys.stdin:
            if line.strip():
                self.handle_line(line)
        self.shutdown()

    def shutdown(self) -> None:
        self.heavy_executor.shutdown(wait=True)
        self.light_executor.shutdown(wait=True)
        if self.service is not None:
            self.service.close()


def parse_arguments(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="atlas_ml.worker")
    parser.add_argument("--module", required=True)
    parser.add_argument("--cache-root", default=os.path.expanduser("~/.cache/atlas"))
    parser.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda"])
    return parser.parse_args(argv)


def resolve_device(requested: str) -> str:
    """`auto` picks CUDA when torch can see a GPU; encoders on CPU are an order of magnitude slower."""
    if requested != "auto":
        return requested
    try:
        import torch
    except ImportError:
        return "cpu"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def main(argv: list[str] | None = None) -> int:
    arguments = parse_arguments(argv)
    worker = Worker(arguments.module, arguments.cache_root, resolve_device(arguments.device))
    worker.serve()
    return 0


if __name__ == "__main__":
    sys.exit(main())

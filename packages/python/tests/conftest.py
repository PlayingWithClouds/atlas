import os
import sys

import numpy as np
import pytest

PACKAGE_ROOT = os.path.dirname(os.path.dirname(__file__))
sys.path.insert(0, PACKAGE_ROOT)

from atlas_ml.service import ModelService  # noqa: E402


class FixedEncoder:
    """Encoder answering from a fixed ref -> vector table. Unknown refs fail to decode."""

    id = "fixed"
    media_kinds = ["image"]

    def __init__(self, vectors: dict, dim: int = 2):
        self.vectors = vectors
        self.dim = dim
        self.embed_calls: list[list[str]] = []

    def embed(self, items):
        self.embed_calls.append([item.ref for item in items])
        rows = [self.vectors.get(item.ref, np.zeros(self.dim)) for item in items]
        return np.array(rows, dtype=np.float32).reshape(len(items), self.dim)


def descriptor(ref: str) -> dict:
    return {"ref": ref, "mediaKind": "image", "location": {"kind": "file", "path": ref}}


@pytest.fixture
def cache_root(tmp_path):
    return str(tmp_path / "cache")


@pytest.fixture
def make_service(cache_root):
    services = []

    def build(vectors: dict, dim: int = 2) -> ModelService:
        service = ModelService(FixedEncoder(vectors, dim), cache_root)
        services.append(service)
        return service

    yield build
    for service in services:
        service.close()

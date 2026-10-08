"""Deterministic encoder for tests: hash-based unit vectors, no models, no network."""

import hashlib

import numpy as np

from atlas_ml.encoder import MediaItem


class FakeEncoder:
    id = "fake"
    dim = 16
    media_kinds = ["image", "video"]

    def vector_for_text(self, text: str) -> np.ndarray:
        digest = hashlib.sha256(text.encode()).digest()
        values = np.frombuffer(digest[:self.dim * 2], dtype=np.uint8).astype(np.float32)
        vector = values[:self.dim] - 127.5 + values[self.dim:] / 255.0
        return vector / np.linalg.norm(vector)

    def embed(self, items: list[MediaItem]) -> np.ndarray:
        if not items:
            return np.zeros((0, self.dim), dtype=np.float32)
        return np.stack([self.vector_for_text(item.ref) for item in items])

    def embed_text(self, texts: list[str]) -> np.ndarray:
        return np.stack([self.vector_for_text(text) for text in texts])


def create_encoder(device: str) -> FakeEncoder:
    return FakeEncoder()

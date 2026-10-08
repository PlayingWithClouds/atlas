import os
import sys

import numpy as np
import pytest
from PIL import Image

PLUGIN_ROOT = os.path.dirname(os.path.dirname(__file__))
sys.path.insert(0, PLUGIN_ROOT)
sys.path.insert(0, os.path.join(PLUGIN_ROOT, "..", "..", "..", "packages", "python"))

from atlas_encoder_siglip import encoder  # noqa: E402
from atlas_ml.encoder import MediaItem  # noqa: E402


def test_exposes_create_encoder():
    assert callable(encoder.create_encoder)


def test_checkpoint_defaults_and_overrides(monkeypatch):
    monkeypatch.delenv("ATLAS_SIGLIP_CHECKPOINT", raising=False)
    assert encoder.checkpoint_name() == "google/siglip-so400m-patch14-384"
    monkeypatch.setenv("ATLAS_SIGLIP_CHECKPOINT", "custom/checkpoint")
    assert encoder.checkpoint_name() == "custom/checkpoint"


def test_frame_count_from_environment(monkeypatch):
    monkeypatch.delenv("ATLAS_SIGLIP_FRAMES", raising=False)
    assert encoder.frame_count_from_environment() == 8
    monkeypatch.setenv("ATLAS_SIGLIP_FRAMES", "4")
    assert encoder.frame_count_from_environment() == 4
    monkeypatch.setenv("ATLAS_SIGLIP_FRAMES", "nonsense")
    assert encoder.frame_count_from_environment() == 8


def test_pool_frame_features_averages_per_item_and_zeroes_empty_items():
    features = np.array([[1, 0], [3, 0], [0, 2]], dtype=np.float32)
    pooled = encoder.pool_frame_features(features, [2, 0, 1], dim=2)
    assert pooled.tolist() == [[2.0, 0.0], [0.0, 0.0], [0.0, 2.0]]


def test_frames_for_items_loads_stills_and_reports_failures(tmp_path):
    path = tmp_path / "still.png"
    Image.new("RGB", (8, 4), (10, 20, 30)).save(path)
    good = MediaItem("good", "image", {"kind": "file", "path": str(path)})
    bad = MediaItem("bad", "image", {"kind": "file", "path": str(tmp_path / "missing.png")})
    frames = encoder.frames_for_items([good, bad], 8)
    assert [len(item_frames) for item_frames in frames] == [1, 0]


@pytest.mark.skipif(os.environ.get("ATLAS_RUN_MODEL_TESTS") != "1", reason="downloads weights")
def test_embeds_with_real_weights(tmp_path):
    siglip = encoder.create_encoder("cpu")
    path = tmp_path / "still.png"
    Image.new("RGB", (64, 64), (200, 10, 10)).save(path)
    item = MediaItem("a", "image", {"kind": "file", "path": str(path)})
    assert siglip.embed([item]).shape == (1, siglip.dim)
    assert siglip.embed_text(["red"]).shape == (1, siglip.dim)

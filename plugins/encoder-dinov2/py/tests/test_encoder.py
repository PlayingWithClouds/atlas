import os
import sys

import pytest
from PIL import Image

PLUGIN_ROOT = os.path.dirname(os.path.dirname(__file__))
sys.path.insert(0, PLUGIN_ROOT)
sys.path.insert(0, os.path.join(PLUGIN_ROOT, "..", "..", "..", "packages", "python"))

from atlas_encoder_dinov2 import encoder  # noqa: E402
from atlas_ml.encoder import MediaItem  # noqa: E402


def test_exposes_create_encoder():
    assert callable(encoder.create_encoder)


def test_variant_defaults_and_overrides(monkeypatch):
    monkeypatch.delenv("ATLAS_DINOV2_MODEL", raising=False)
    assert encoder.variant_name() == "vit_small_patch14_dinov2.lvd142m"
    monkeypatch.setenv("ATLAS_DINOV2_MODEL", "vit_base_patch14_dinov2.lvd142m")
    assert encoder.variant_name() == "vit_base_patch14_dinov2.lvd142m"


def test_encoder_id_is_per_variant_and_path_safe():
    assert encoder.encoder_id("a/b") == "dinov2-a-b"


def test_load_images_marks_failures_as_none(tmp_path):
    path = tmp_path / "ok.png"
    Image.new("RGB", (4, 4)).save(path)
    items = [MediaItem("ok", "image", {"kind": "file", "path": str(path)}),
             MediaItem("bad", "image", {"kind": "file", "path": str(tmp_path / "no.png")})]
    images = encoder.load_images(items)
    assert images[0] is not None
    assert images[1] is None


@pytest.mark.skipif(os.environ.get("ATLAS_RUN_MODEL_TESTS") != "1", reason="downloads weights")
def test_embeds_with_real_weights(tmp_path):
    dinov2 = encoder.create_encoder("cpu")
    path = tmp_path / "still.png"
    Image.new("RGB", (64, 64), (200, 10, 10)).save(path)
    item = MediaItem("a", "image", {"kind": "file", "path": str(path)})
    assert dinov2.embed([item]).shape == (1, dinov2.dim)

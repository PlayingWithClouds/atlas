import os
import sys

import numpy as np
import pytest
from PIL import Image

PLUGIN_ROOT = os.path.dirname(os.path.dirname(__file__))
sys.path.insert(0, PLUGIN_ROOT)
sys.path.insert(0, os.path.join(PLUGIN_ROOT, "..", "..", "..", "packages", "python"))

from atlas_encoder_joytag import encoder  # noqa: E402
from atlas_ml.encoder import MediaItem  # noqa: E402


def test_exposes_create_encoder():
    assert callable(encoder.create_encoder)


def test_pad_to_square_centers_on_white():
    image = Image.new("RGB", (10, 4), (0, 0, 0))
    padded = encoder.pad_to_square(image)
    assert padded.size == (10, 10)
    assert padded.getpixel((0, 0)) == (255, 255, 255)
    assert padded.getpixel((5, 5)) == (0, 0, 0)


def test_preprocess_shape_dtype_and_normalization():
    image = Image.new("RGB", (30, 20), (255, 255, 255))
    array = encoder.preprocess(image, size=16)
    assert array.shape == (3, 16, 16)
    assert array.dtype == np.float32
    expected = (1.0 - encoder.MEAN) / encoder.STANDARD_DEVIATION
    assert np.allclose(array[:, 0, 0], expected, atol=1e-5)


def test_cache_directory_prefers_environment(monkeypatch, tmp_path):
    monkeypatch.setenv("ATLAS_PLUGIN_CACHE", str(tmp_path))
    assert encoder.cache_directory() == str(tmp_path)


@pytest.mark.skipif(os.environ.get("ATLAS_RUN_MODEL_TESTS") != "1", reason="downloads weights")
def test_embeds_with_real_weights(tmp_path):
    joytag = encoder.create_encoder("cpu")
    path = tmp_path / "still.png"
    Image.new("RGB", (64, 48), (200, 10, 10)).save(path)
    item = MediaItem("a", "image", {"kind": "file", "path": str(path)})
    assert joytag.embed([item]).shape == (1, joytag.dim)

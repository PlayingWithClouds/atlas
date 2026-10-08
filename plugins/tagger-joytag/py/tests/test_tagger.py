import os
import sys

import numpy as np
import pytest
from PIL import Image

PLUGIN_ROOT = os.path.dirname(os.path.dirname(__file__))
sys.path.insert(0, PLUGIN_ROOT)
sys.path.insert(0, os.path.join(PLUGIN_ROOT, "..", "..", "..", "packages", "python"))

from atlas_ml.encoder import MediaItem  # noqa: E402
from atlas_ml.tagger import Tagger  # noqa: E402
from atlas_tagger_joytag import tagger  # noqa: E402


def test_exposes_create_tagger():
    assert callable(tagger.create_tagger)


def test_pad_to_square_centers_on_white():
    padded = tagger.pad_to_square(Image.new("RGB", (10, 4), (0, 0, 0)))
    assert padded.size == (10, 10)
    assert padded.getpixel((0, 0)) == (255, 255, 255)
    assert padded.getpixel((5, 5)) == (0, 0, 0)


def test_preprocess_shape_dtype_and_normalization():
    array = tagger.preprocess(Image.new("RGB", (30, 20), (255, 255, 255)), size=16)
    assert array.shape == (3, 16, 16)
    assert array.dtype == np.float32
    assert np.allclose(array[:, 0, 0], (1.0 - tagger.MEAN) / tagger.STANDARD_DEVIATION, atol=1e-5)


def test_scores_by_tag_pairs_vocabulary_with_probabilities():
    scores = tagger.scores_by_tag(["a", "b"], np.array([0.25, 0.75], dtype=np.float32))
    assert scores == {"a": 0.25, "b": 0.75}


def test_weights_directory_prefers_shared_then_plugin_cache(monkeypatch, tmp_path):
    monkeypatch.setenv("ATLAS_PLUGIN_CACHE", str(tmp_path / "plugin"))
    assert tagger.cache_directory() == str(tmp_path / "plugin")
    monkeypatch.setenv("ATLAS_JOYTAG_WEIGHTS", str(tmp_path / "shared"))
    assert tagger.cache_directory() == str(tmp_path / "shared")


@pytest.mark.skipif(os.environ.get("ATLAS_RUN_MODEL_TESTS") != "1", reason="downloads weights")
def test_tags_with_real_weights(tmp_path):
    joytag = tagger.create_tagger("cpu")
    assert isinstance(joytag, Tagger)
    path = tmp_path / "still.png"
    Image.new("RGB", (64, 48), (200, 10, 10)).save(path)
    rows = joytag.tag([MediaItem("a", "image", {"kind": "file", "path": str(path)}),
                       MediaItem("b", "image", {"kind": "file", "path": str(tmp_path / "missing")})])
    assert len(rows[0]) == len(joytag.tags)
    assert rows[1] == {}

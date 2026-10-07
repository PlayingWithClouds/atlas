"""Tests for temporal-span ref parsing in the SigLIP embedder.

Run with the model plugin venv:  plugins/model/.venv/bin/python tests/test_span.py
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "plugins", "model"))

from embedder import parse_span  # noqa: E402


def test_parse_span():
    assert parse_span("/videos/x.mp4#t=12.0,16.0") == ("/videos/x.mp4", 12.0, 16.0)
    assert parse_span("http://h/a.mp4#t=0.000,4.000") == ("http://h/a.mp4", 0.0, 4.0)
    # plain image / non-temporal refs
    assert parse_span("/frames/frame_00001.jpg") is None
    assert parse_span("http://host/img.png") is None
    # malformed spans
    assert parse_span("x.mp4#t=1.0") is None
    assert parse_span("x.mp4#t=a,b") is None
    assert parse_span("x.mp4#t=4.0,2.0") is None  # end before start


if __name__ == "__main__":
    test_parse_span()
    print("test_span OK")

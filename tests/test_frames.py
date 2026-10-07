"""Tests for the SigLIP embedder's clip frame sampling.

Sampling used to run one ffmpeg seek per frame; it now decodes the whole window in one
pass. These pin the sample timestamps to what the seeks produced, because a drift there
is silent — the vectors stay plausible, they just describe the wrong moment.

Run with the model plugin venv:  plugins/model/.venv/bin/python tests/test_frames.py
"""

import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "plugins", "model"))

import numpy as np  # noqa: E402
import torch  # noqa: E402

from embedder import (  # noqa: E402
    SIGLIP_INPUT,
    SiglipEmbedder,
    sample_frames,
    window_command,
)


def seek_offset(command: list[str]) -> float:
    return float(command[command.index("-ss") + 1])


def filter_chain(command: list[str]) -> str:
    return command[command.index("-vf") + 1]


def test_sample_timestamps_are_step_midpoints():
    """8 frames over [12, 16) must sit at 12.25, 12.75, ... — the midpoint of each of
    the 8 half-second steps, which is where the per-frame seeks landed."""
    command = window_command("/v.mp4", 12.0, 4.0, 8, "/out/%03d.jpg")
    step = 4.0 / 8
    assert seek_offset(command) == 12.0 + step / 2
    assert f"fps={1 / step:.6f}" in filter_chain(command)
    assert command[command.index("-frames:v") + 1] == "8"
    # -t bounds the pass to the window, so a short tail cannot over-read the source.
    assert float(command[command.index("-t") + 1]) == 4.0


def test_remote_source_carries_cdn_headers():
    local = window_command("/v.mp4", 0.0, 4.0, 8, "/out/%03d.jpg")
    remote = window_command("https://cdn/v.mp4", 0.0, 4.0, 8, "/out/%03d.jpg")
    assert "-user_agent" not in local
    assert "-user_agent" in remote
    assert "Referer" in remote[remote.index("-headers") + 1]
    # The headers have to precede -i or ffmpeg applies them to no input.
    assert remote.index("-headers") < remote.index("-i")


def make_video(path: str, seconds: int) -> None:
    """A 10s clip whose frames visibly change over time, so sampling the wrong moment
    shows up as duplicate frames rather than passing quietly."""
    subprocess.run(
        ["ffmpeg", "-nostdin", "-loglevel", "error", "-y",
         "-f", "lavfi", "-i", f"testsrc2=size=640x480:rate=25:duration={seconds}",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "25", path],
        check=True,
    )


def test_sample_frames_decodes_the_whole_window():
    with tempfile.TemporaryDirectory() as workdir:
        video = os.path.join(workdir, "clip.mp4")
        make_video(video, 10)

        frames = sample_frames(video, 2.0, 6.0, 8)
        assert len(frames) == 8, f"expected 8 frames, got {len(frames)}"
        # Downscaled during the decode; both sides must clear the model input size.
        for frame in frames:
            assert min(frame.size) >= SIGLIP_INPUT, frame.size
        # testsrc2 animates, so eight distinct moments cannot be one repeated frame.
        assert len({frame.tobytes() for frame in frames}) == 8


def test_degenerate_span_yields_one_frame():
    """A zero-length span has no window to walk; it still has to embed as something."""
    with tempfile.TemporaryDirectory() as workdir:
        video = os.path.join(workdir, "clip.mp4")
        make_video(video, 4)
        assert len(sample_frames(video, 1.0, 1.0, 8)) == 1


def test_missing_source_returns_no_frames():
    """A dead ref must decode to nothing, so the pool records None instead of a vector."""
    assert sample_frames("/nonexistent/video.mp4", 0.0, 4.0, 8) == []


class StubEmbedder:
    """SiglipEmbedder's pooling without its 2GB of weights. Frames stand in as their
    own one-dim embedding, so the pooled vector is predictable."""

    device = "cpu"

    def _encode(self, frames, batch_size):
        return torch.tensor([[float(frame)] for frame in frames])

    _pool_clips = SiglipEmbedder._pool_clips


def test_pool_clips_keeps_each_clip_to_its_own_frames():
    """The frames of every clip go through the backbone in shared passes, so pooling has
    to walk back into the flat result by clip length. Slipping that offset silently gives
    a clip its neighbour's vector.

    Normalizing a one-dim vector leaves only its sign, so the clips are chosen to pool to
    different signs: any misread of the offset flips one of them."""
    embedder = StubEmbedder()
    clips = [[1.0, 1.0], [-1.0], [-1.0, -1.0, 3.0]]
    #        mean +1      mean -1  mean +1/3
    signs = [float(vector[0]) for vector in embedder._pool_clips(clips, 2)]

    assert signs == [1.0, -1.0, 1.0]


def test_pool_clips_reports_none_for_a_clip_that_did_not_decode():
    """A ref that decoded nothing must stay None. A zero vector would read as a valid
    point in the pool and quietly bias every head trained on it."""
    embedder = StubEmbedder()
    vectors = embedder._pool_clips([[1.0], [], [-2.0]], 2)

    assert vectors[1] is None
    # The empty clip consumed no frames, so the clip behind it still reads its own.
    assert float(vectors[0][0]) == 1.0
    assert float(vectors[2][0]) == -1.0
    # Nothing decoded at all: every ref reports None rather than one shared vector.
    assert embedder._pool_clips([[], []], 2) == [None, None]


def test_pool_clips_batches_without_changing_the_result():
    """Frames are encoded in fixed-size passes; the pass boundary must not fall inside a
    clip in a way that changes its vector."""
    embedder = StubEmbedder()
    clips = [[1.0, 1.0], [-1.0], [-1.0, -1.0, 3.0]]
    one_pass = embedder._pool_clips(clips, 64)
    many_passes = embedder._pool_clips(clips, 1)

    assert [float(v[0]) for v in one_pass] == [float(v[0]) for v in many_passes]


def test_decode_clips_returns_frames_in_ref_order():
    """Decoding runs across threads now; if results came back in completion order the
    pool would key every vector to the wrong ref."""
    with tempfile.TemporaryDirectory() as workdir:
        video = os.path.join(workdir, "clip.mp4")
        make_video(video, 10)

        class OrderedStub:
            frames = 8
            _clip_frames = SiglipEmbedder._clip_frames
            _try_clip_frames = SiglipEmbedder._try_clip_frames
            _decode_clips = SiglipEmbedder._decode_clips

        refs = [f"{video}#t={start}.000,{start + 1}.000" for start in range(6)]
        # Two refs that cannot be read: a dead video, and a plain image ref whose fetch
        # raises rather than returning nothing. Neither may shift the refs behind it.
        refs.insert(3, "/nonexistent/video.mp4#t=0.000,4.000")
        refs.insert(5, "/nonexistent/still.jpg")

        clips = OrderedStub()._decode_clips(refs)
        assert len(clips) == len(refs)
        assert clips[3] == [] and clips[5] == []
        good = [clip for index, clip in enumerate(clips) if index not in (3, 5)]
        assert len(good) == 6
        assert all(len(clip) == 8 for clip in good)


if __name__ == "__main__":
    test_sample_timestamps_are_step_midpoints()
    test_remote_source_carries_cdn_headers()
    test_sample_frames_decodes_the_whole_window()
    test_degenerate_span_yields_one_frame()
    test_missing_source_returns_no_frames()
    test_pool_clips_keeps_each_clip_to_its_own_frames()
    test_pool_clips_reports_none_for_a_clip_that_did_not_decode()
    test_pool_clips_batches_without_changing_the_result()
    test_decode_clips_returns_frames_in_ref_order()
    print("test_frames OK")

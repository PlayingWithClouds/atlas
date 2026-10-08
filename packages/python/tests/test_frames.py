import shutil
import subprocess

import pytest

from atlas_ml.encoder import (
    FRAME_SIZE,
    ffmpeg_input_options,
    sample_clip_frames,
    sample_video_frames,
    window_command,
    MediaItem,
)

FILE = {"kind": "file", "path": "/v.mp4"}
REMOTE = {"kind": "url", "url": "https://cdn/v.mp4",
          "headers": {"User-Agent": "UA", "Referer": "https://example.test/"}}

needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg missing")


def option_after(command: list[str], flag: str) -> str:
    return command[command.index(flag) + 1]


def test_sample_timestamps_are_step_midpoints():
    command = window_command(FILE, 12.0, 4.0, 8, "/out/%03d.jpg")
    step = 4.0 / 8
    assert float(option_after(command, "-ss")) == 12.0 + step / 2
    assert f"fps={1 / step:.6f}" in option_after(command, "-vf")
    assert option_after(command, "-frames:v") == "8"
    assert float(option_after(command, "-t")) == 4.0


def test_headers_come_from_the_location_and_precede_input():
    command = window_command(REMOTE, 0.0, 4.0, 8, "/out/%03d.jpg")
    assert option_after(command, "-user_agent") == "UA"
    assert "Referer: https://example.test/" in option_after(command, "-headers")
    assert command.index("-headers") < command.index("-i")


def test_no_headers_means_no_header_flags():
    assert ffmpeg_input_options(FILE) == []
    assert ffmpeg_input_options({"kind": "url", "url": "http://x"}) == []


def test_hls_locations_relax_the_segment_extension_check():
    hls = {"kind": "url", "url": "http://x/manifest", "format": "hls"}
    command = window_command(hls, 0.0, 4.0, 8, "/out/%03d.jpg")
    assert option_after(command, "-extension_picky") == "0"
    assert command.index("-extension_picky") < command.index("-i")


def make_video(path: str, seconds: int) -> None:
    subprocess.run(
        ["ffmpeg", "-nostdin", "-loglevel", "error", "-y",
         "-f", "lavfi", "-i", f"testsrc2=size=640x480:rate=25:duration={seconds}",
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "25", path],
        check=True,
    )


@needs_ffmpeg
def test_sample_frames_decodes_the_whole_window(tmp_path):
    video = str(tmp_path / "clip.mp4")
    make_video(video, 10)
    frames = sample_video_frames({"kind": "file", "path": video}, (2.0, 6.0), 8)
    assert len(frames) == 8
    for frame in frames:
        assert min(frame.size) >= FRAME_SIZE
    assert len({frame.tobytes() for frame in frames}) == 8


@needs_ffmpeg
def test_degenerate_span_yields_one_frame(tmp_path):
    video = str(tmp_path / "clip.mp4")
    make_video(video, 4)
    assert len(sample_video_frames({"kind": "file", "path": video}, (1.0, 1.0), 8)) == 1


@needs_ffmpeg
def test_missing_source_returns_no_frames():
    location = {"kind": "file", "path": "/nonexistent/video.mp4"}
    assert sample_video_frames(location, (0.0, 4.0), 8) == []


@needs_ffmpeg
def test_decode_keeps_item_order_and_survives_bad_items(tmp_path):
    video = str(tmp_path / "clip.mp4")
    make_video(video, 10)
    good = {"kind": "file", "path": video}
    bad = {"kind": "file", "path": "/nonexistent/video.mp4"}
    items = [MediaItem(f"r{index}", "video", good, (float(index), index + 1.0))
             for index in range(4)]
    items.insert(2, MediaItem("dead", "video", bad, (0.0, 4.0)))

    clips = sample_clip_frames(items, 4)
    assert len(clips) == 5
    assert clips[2] == []
    assert all(len(clips[index]) == 4 for index in (0, 1, 3, 4))

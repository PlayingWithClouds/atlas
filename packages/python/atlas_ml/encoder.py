"""Encoder interface implemented by encoder plugins, plus media-loading helpers."""

import io
import os
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Protocol, runtime_checkable

import numpy as np
import requests
from PIL import Image

from atlas_ml.log import log

FETCH_TIMEOUT_SECONDS = 30
DECODE_TIMEOUT_SECONDS = 45
DECODE_WORKERS = 6
FRAME_SIZE = 384


@dataclass
class MediaItem:
    ref: str
    media_kind: str
    location: dict
    span: tuple[float, float] | None = None


@runtime_checkable
class Encoder(Protocol):
    """Turns media into unit-length vectors.

    `embed` returns one row per item. A row that is all zeros (or not finite) marks an
    item that could not be decoded; the service skips it instead of pooling it.
    `embed_text` is optional and enables text search.
    """

    id: str
    dim: int
    media_kinds: list[str]

    def embed(self, items: list[MediaItem]) -> np.ndarray: ...


def media_item_from_json(payload: dict) -> MediaItem:
    return MediaItem(
        ref=payload["ref"],
        media_kind=payload.get("mediaKind", ""),
        location=payload["location"],
        span=parse_span(payload.get("span")),
    )


def parse_span(value) -> tuple[float, float] | None:
    """Accepts {start, end}, a [start, end] pair or None; rejects inverted ranges."""
    if value is None:
        return None
    try:
        if isinstance(value, dict):
            start, end = float(value["start"]), float(value["end"])
        else:
            start, end = float(value[0]), float(value[1])
    except (KeyError, IndexError, TypeError, ValueError):
        return None
    if end < start:
        return None
    return start, end


def split_span_ref(ref: str) -> tuple[str, float, float] | None:
    """Splits a media-fragment ref "<source>#t=<start>,<end>"; None for plain refs."""
    parts = ref.rsplit("#t=", 1)
    if len(parts) != 2:
        return None
    bounds = parts[1].split(",")
    if len(bounds) != 2:
        return None
    span = parse_span(bounds)
    if span is None:
        return None
    return parts[0], span[0], span[1]


def location_source(location: dict) -> str:
    if location["kind"] == "file":
        return location["path"]
    return location["url"]


def location_headers(location: dict) -> dict:
    if location["kind"] == "url":
        return location.get("headers") or {}
    return {}


def load_image(location: dict) -> Image.Image:
    """Reads an image from a file or from an HTTP URL using the location's own headers."""
    if location["kind"] == "file":
        with Image.open(location["path"]) as image:
            return image.convert("RGB")
    response = requests.get(
        location["url"], headers=location_headers(location), timeout=FETCH_TIMEOUT_SECONDS
    )
    response.raise_for_status()
    with Image.open(io.BytesIO(response.content)) as image:
        return image.convert("RGB")


def ffmpeg_input_options(location: dict) -> list[str]:
    """Per-input ffmpeg flags; they must precede `-i` to apply to that input."""
    if location["kind"] != "url":
        return []
    return header_options(location_headers(location)) + format_options(location)


def format_options(location: dict) -> list[str]:
    """Proxied HLS segments often lack a media extension, which the HLS demuxer rejects by default."""
    path = location["url"].split("?", 1)[0].split("#", 1)[0].lower()
    if location.get("format") == "hls" or path.endswith(".m3u8"):
        return ["-extension_picky", "0"]
    return []


def header_options(headers: dict) -> list[str]:
    if not headers:
        return []
    options = []
    user_agent = headers.get("User-Agent")
    if user_agent:
        options += ["-user_agent", user_agent]
    other = {name: value for name, value in headers.items() if name != "User-Agent"}
    if other:
        joined = "".join(f"{name}: {value}\r\n" for name, value in other.items())
        options += ["-headers", joined]
    return options


def run_ffmpeg(command: list[str]) -> subprocess.CompletedProcess | None:
    try:
        return subprocess.run(command, capture_output=True, timeout=DECODE_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        log(f"ffmpeg timed out after {DECODE_TIMEOUT_SECONDS}s: {command[-1]}")
        return None
    except FileNotFoundError:
        log("ffmpeg is not installed")
        return None


def seek_frame(location: dict, seconds: float) -> Image.Image | None:
    """Decodes one frame at `seconds`."""
    command = ["ffmpeg", "-nostdin", "-loglevel", "error", "-ss", f"{seconds:.3f}",
               *ffmpeg_input_options(location), "-i", location_source(location),
               "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"]
    result = run_ffmpeg(command)
    if result is None or result.returncode != 0 or not result.stdout:
        return None
    return Image.open(io.BytesIO(result.stdout)).convert("RGB")


def window_command(location: dict, start: float, span: float, count: int,
                   output_pattern: str) -> list[str]:
    """ffmpeg invocation emitting `count` evenly spaced frames in one pass.

    Frames land on the midpoint of each of the equal steps: the seek is offset half a
    step and the fps filter places the rest. Frames are downscaled during decode so a
    batch of clips is not held at source resolution.
    """
    step = span / count
    scale = f"scale=w={FRAME_SIZE}:h={FRAME_SIZE}:force_original_aspect_ratio=increase"
    return ["ffmpeg", "-nostdin", "-loglevel", "error", "-y",
            "-ss", f"{start + step / 2:.3f}", *ffmpeg_input_options(location),
            "-i", location_source(location),
            "-t", f"{span:.3f}", "-vf", f"fps={1 / step:.6f},{scale}",
            "-frames:v", str(count), "-q:v", "3", output_pattern]


def decode_window(location: dict, start: float, span: float, count: int) -> list[Image.Image]:
    with tempfile.TemporaryDirectory(prefix="atlas-frames-") as workdir:
        pattern = os.path.join(workdir, "frame_%03d.jpg")
        result = run_ffmpeg(window_command(location, start, span, count, pattern))
        if result is None or result.returncode != 0:
            return []
        return read_frames(workdir)


def read_frames(directory: str) -> list[Image.Image]:
    frames = []
    for name in sorted(os.listdir(directory)):
        # convert() loads eagerly, which it must: the directory is about to go.
        with Image.open(os.path.join(directory, name)) as image:
            frames.append(image.convert("RGB"))
    return frames


def sample_video_frames(location: dict, span: tuple[float, float] | None,
                        count: int) -> list[Image.Image]:
    """Up to `count` frames evenly spaced across the span (the first frame if no span)."""
    if span is None:
        span = (0.0, 0.0)
    start, end = span
    length = max(end - start, 0.0)
    if length <= 0:
        frame = seek_frame(location, start)
        if frame is None:
            return []
        return [frame]
    return decode_window(location, start, length, max(count, 1))


def sample_clip_frames(items: list[MediaItem], count: int) -> list[list[Image.Image]]:
    """Frames for every item, decoded concurrently and returned in item order.

    ffmpeg spends its time waiting on the source, so threads overlap despite the GIL.
    An item that fails to decode yields an empty list instead of failing the batch.
    """
    def decode(item: MediaItem) -> list[Image.Image]:
        try:
            return sample_video_frames(item.location, item.span, count)
        except Exception as error:
            log(f"{item.ref} failed to decode: {error}")
            return []

    workers = min(DECODE_WORKERS, max(len(items), 1))
    with ThreadPoolExecutor(max_workers=workers) as executor:
        return list(executor.map(decode, items))

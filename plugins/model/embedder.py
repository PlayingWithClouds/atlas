"""Frozen image embedder.

Default backbone: DINOv2 ViT-S/14 (21M params). Pure vision, small, fast,
strong features. Runs once per image; results are cached by the store.
"""

import io
import urllib.request

import numpy as np
import timm
import torch
from PIL import Image
from timm.data import create_transform, resolve_data_config

DEFAULT_MODEL = "vit_small_patch14_dinov2.lvd142m"
INPUT_SIZE = 224

# pornpics and similar CDNs reject requests without a browser-like UA / referer.
_FETCH_HEADERS = {"User-Agent": "Mozilla/5.0", "Referer": "https://www.pornpics.com/"}


def load_image(ref: str) -> Image.Image:
    if ref.startswith("http://") or ref.startswith("https://"):
        request = urllib.request.Request(ref, headers=_FETCH_HEADERS)
        with urllib.request.urlopen(request, timeout=30) as response:
            data = response.read()
        return Image.open(io.BytesIO(data)).convert("RGB")
    return Image.open(ref).convert("RGB")


class Embedder:
    def __init__(self, model_name: str = DEFAULT_MODEL, device: str | None = None):
        if device is None:
            device = "cuda" if torch.cuda.is_available() else "cpu"
        self.device = device
        self.model_name = model_name

        # img_size=224 keeps inference fast; patch14 interpolates its position
        # embeddings for the smaller grid automatically.
        self.model = (
            timm.create_model(model_name, pretrained=True, num_classes=0, img_size=INPUT_SIZE)
            .eval()
            .to(device)
        )
        config = resolve_data_config({}, model=self.model)
        config["input_size"] = (3, INPUT_SIZE, INPUT_SIZE)
        self.transform = create_transform(**config)
        self.dim = int(self.model.num_features)

    @torch.no_grad()
    def embed_refs(self, refs: list[str], batch_size: int = 16) -> np.ndarray:
        vectors: list[np.ndarray] = []
        batch: list[torch.Tensor] = []
        for ref in refs:
            image = load_image(ref)
            batch.append(self.transform(image))
            if len(batch) == batch_size:
                vectors.append(self._run_batch(batch))
                batch = []
        if batch:
            vectors.append(self._run_batch(batch))
        if not vectors:
            return np.zeros((0, self.dim), dtype=np.float32)
        return np.concatenate(vectors, axis=0)

    def _run_batch(self, batch: list[torch.Tensor]) -> np.ndarray:
        tensor = torch.stack(batch).to(self.device)
        features = self.model(tensor)
        features = torch.nn.functional.normalize(features, dim=-1)
        return features.cpu().numpy().astype(np.float32)


# --- JoyTag backbone ---------------------------------------------------------
# ViT-B/16, 91.5M params, 448px, trained on ~4M danbooru + photographic images.
# NSFW-aware features far stronger than DINOv2 for explicit acts/positions.

import os

JOYTAG_DIR = os.path.expanduser("~/.cache/atlas/joytag")
_JOYTAG_HF = "https://huggingface.co/fancyfeast/joytag/resolve/main"
_JOYTAG_MODELS_PY = "https://raw.githubusercontent.com/fpgaminer/joytag/main/Models.py"
# CLIP normalization; images are white-padded to square then resized to 448.
_JOYTAG_MEAN = [0.48145466, 0.4578275, 0.40821073]
_JOYTAG_STD = [0.26862954, 0.26130258, 0.27577711]


def _ensure_joytag() -> None:
    os.makedirs(JOYTAG_DIR, exist_ok=True)
    sources = {
        "config.json": f"{_JOYTAG_HF}/config.json",
        "top_tags.txt": f"{_JOYTAG_HF}/top_tags.txt",
        "model.safetensors": f"{_JOYTAG_HF}/model.safetensors",
        "Models.py": _JOYTAG_MODELS_PY,
    }
    for name, url in sources.items():
        path = os.path.join(JOYTAG_DIR, name)
        if os.path.exists(path) and os.path.getsize(path) > 100:
            continue
        request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(request, timeout=600) as response, open(path, "wb") as handle:
            handle.write(response.read())


class JoyTagEmbedder:
    model_name = "joytag"

    def __init__(self, device: str | None = None):
        import sys

        _ensure_joytag()
        if JOYTAG_DIR not in sys.path:
            sys.path.insert(0, JOYTAG_DIR)
        from Models import VisionModel

        if device is None:
            device = "cuda" if torch.cuda.is_available() else "cpu"
        self.device = device
        self.model_name = "joytag"
        self.model = VisionModel.load_model(JOYTAG_DIR, device=device).eval().to(device)
        self.image_size = int(self.model.image_size)
        self.dim = 768

    def _prepare(self, image: Image.Image) -> torch.Tensor:
        image = image.convert("RGB")
        largest = max(image.size)
        padded = Image.new("RGB", (largest, largest), (255, 255, 255))
        padded.paste(image, ((largest - image.size[0]) // 2, (largest - image.size[1]) // 2))
        if largest != self.image_size:
            padded = padded.resize((self.image_size, self.image_size), Image.BICUBIC)
        import torchvision.transforms.functional as TVF

        tensor = TVF.pil_to_tensor(padded) / 255.0
        return TVF.normalize(tensor, mean=_JOYTAG_MEAN, std=_JOYTAG_STD)

    @torch.no_grad()
    def embed_refs(self, refs: list[str], batch_size: int = 8) -> np.ndarray:
        vectors: list[np.ndarray] = []
        batch: list[torch.Tensor] = []
        for ref in refs:
            batch.append(self._prepare(load_image(ref)))
            if len(batch) == batch_size:
                vectors.append(self._run(batch))
                batch = []
        if batch:
            vectors.append(self._run(batch))
        if not vectors:
            return np.zeros((0, self.dim), dtype=np.float32)
        return np.concatenate(vectors, axis=0)

    def _run(self, batch: list[torch.Tensor]) -> np.ndarray:
        tensor = torch.stack(batch).to(self.device)
        out = self.model({"image": tensor}, return_embeddings=True)
        return out["embeddings"].cpu().numpy().astype(np.float32)


# --- SigLIP-video backbone ---------------------------------------------------
# SigLIP SoViT-400m/14 @ 384px (1152-dim). A temporal span ref carries a time range
# (media-fragment URI "<source>#t=<start>,<end>"); the embedder samples frames across
# that range, encodes each, and mean-pools them into one clip vector. A plain image ref
# (no "#t=") is treated as a single-frame clip, so the same backbone serves both.

import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor

SIGLIP_MODEL = "google/siglip-so400m-patch14-384"
SIGLIP_INPUT = 384
SIGLIP_FRAMES = int(os.environ.get("SIGLIP_FRAMES", "8"))
# How many clips decode at once. ffmpeg spends its time waiting on the source rather
# than in Python, so threads overlap despite the GIL.
SIGLIP_DECODE_WORKERS = int(os.environ.get("SIGLIP_DECODE_WORKERS", "6"))
# Frames per forward pass, not clips per pass: a clip carries SIGLIP_FRAMES frames, so
# batching by clip would put an unbounded number of 384px images on the GPU at once.
SIGLIP_FRAME_BATCH = int(os.environ.get("SIGLIP_FRAME_BATCH", "16"))
# A CDN that accepts the connection and then stalls would otherwise hang the embed.
# Kept well under the caller's 120s budget for the whole batch, so one bad clip cannot
# eat the deadline for the fifteen it was batched with.
DECODE_TIMEOUT = 45


def parse_span(ref: str):
    """Split a media-fragment ref into (source, t_start, t_end), or None if it is a
    plain (non-temporal) ref."""
    marker = ref.rsplit("#t=", 1)
    if len(marker) != 2:
        return None
    base, span = marker
    parts = span.split(",")
    if len(parts) != 2:
        return None
    try:
        t_start = float(parts[0])
        t_end = float(parts[1])
    except ValueError:
        return None
    if t_end < t_start:
        return None
    return base, t_start, t_end


def _input_opts(source: str) -> list[str]:
    if not (source.startswith("http://") or source.startswith("https://")):
        return []
    return ["-user_agent", _FETCH_HEADERS["User-Agent"],
            "-headers", f"Referer: {_FETCH_HEADERS['Referer']}\r\n"]


def _run_ffmpeg(command: list[str]) -> subprocess.CompletedProcess | None:
    try:
        return subprocess.run(command, capture_output=True, timeout=DECODE_TIMEOUT)
    except subprocess.TimeoutExpired:
        print(f"ffmpeg timed out after {DECODE_TIMEOUT}s: {command[-1]}")
        return None


def _seek_frame(source: str, seconds: float) -> Image.Image | None:
    """Decode one frame at `seconds` from a video source via ffmpeg (local path or URL)."""
    command = ["ffmpeg", "-nostdin", "-loglevel", "error", "-ss", f"{seconds:.3f}",
               *_input_opts(source), "-i", source, "-frames:v", "1",
               "-f", "image2pipe", "-vcodec", "png", "-"]
    result = _run_ffmpeg(command)
    if result is None or result.returncode != 0 or not result.stdout:
        return None
    return Image.open(io.BytesIO(result.stdout)).convert("RGB")


def window_command(source: str, t_start: float, span: float, k: int,
                   out_pattern: str) -> list[str]:
    """ffmpeg invocation emitting k evenly spaced frames from one pass over the window.

    Sampling lands on the midpoint of each of the k equal steps — the same timestamps
    the old per-frame seeks used — by offsetting the seek half a step and letting the
    fps filter place the rest.
    """
    step = span / k
    # Downscale during the decode. The processor resizes to SIGLIP_INPUT anyway, so the
    # full-resolution frames were only ever a step on the way there — and a batch of
    # clips held at source resolution is hundreds of megabytes of pixels.
    scale = (f"scale=w={SIGLIP_INPUT}:h={SIGLIP_INPUT}"
             ":force_original_aspect_ratio=increase")
    return ["ffmpeg", "-nostdin", "-loglevel", "error", "-y",
            "-ss", f"{t_start + step / 2:.3f}", *_input_opts(source), "-i", source,
            "-t", f"{span:.3f}", "-vf", f"fps={1 / step:.6f},{scale}",
            "-frames:v", str(k), "-q:v", "3", out_pattern]


def _decode_window(source: str, t_start: float, span: float, k: int) -> list[Image.Image]:
    """Decode k evenly spaced frames out of one pass over [t_start, t_start + span).

    Seeking per frame cost k ffmpeg processes per clip, each re-opening the source and
    re-seeking from the preceding keyframe.
    """
    with tempfile.TemporaryDirectory(prefix="atlas-frames-") as workdir:
        pattern = os.path.join(workdir, "frame_%03d.jpg")
        result = _run_ffmpeg(window_command(source, t_start, span, k, pattern))
        if result is None or result.returncode != 0:
            return []
        frames = []
        # convert() reads the file eagerly, which it must: the directory is about to go.
        for name in sorted(os.listdir(workdir)):
            with Image.open(os.path.join(workdir, name)) as image:
                frames.append(image.convert("RGB"))
        return frames


def sample_frames(source: str, t_start: float, t_end: float, k: int) -> list[Image.Image]:
    """Sample up to k frames evenly across [t_start, t_end)."""
    span = max(t_end - t_start, 0.0)
    count = max(k, 1)
    if span <= 0:
        frame = _seek_frame(source, t_start)
        if frame is None:
            return []
        return [frame]
    return _decode_window(source, t_start, span, count)


# SigLIP is a contrastive image-text model, so a query encoded by its text tower lands
# in the same space as the clip vectors the vision tower produced. That makes free-text
# search over an already-embedded session a cosine sort, with no extra model and no
# labels — the text tower is the half of the backbone atlas was not using.
SIGLIP_TEXT_DEVICE = os.environ.get("SIGLIP_TEXT_DEVICE", "cpu")
# The context length SigLIP was trained with. Padding to anything else quietly degrades
# the embedding rather than failing, which is the worst way for this to be wrong.
SIGLIP_TEXT_TOKENS = 64


class SiglipTextEncoder:
    """Encodes search queries into the clip vectors' space.

    Kept on the CPU by default: it runs once per search, and the GPU is usually busy
    with the vision tower it shares a checkpoint with.
    """

    def __init__(self, device: str | None = None):
        from transformers import AutoTokenizer, SiglipTextModel

        self.device = device or SIGLIP_TEXT_DEVICE
        self.tokenizer = AutoTokenizer.from_pretrained(SIGLIP_MODEL)
        self.model = SiglipTextModel.from_pretrained(SIGLIP_MODEL).eval().to(self.device)

    @torch.no_grad()
    def encode(self, phrases: list[str]) -> np.ndarray:
        tokens = self.tokenizer(phrases, padding="max_length", max_length=SIGLIP_TEXT_TOKENS,
                                truncation=True, return_tensors="pt").to(self.device)
        pooled = self.model(**tokens).pooler_output
        pooled = torch.nn.functional.normalize(pooled, dim=-1)
        return pooled.cpu().numpy().astype(np.float32)


class SiglipEmbedder:
    model_name = "siglip"

    def __init__(self, device: str | None = None, frames: int = SIGLIP_FRAMES):
        from transformers import AutoImageProcessor, SiglipVisionModel

        if device is None:
            device = "cuda" if torch.cuda.is_available() else "cpu"
        self.device = device
        self.model_name = "siglip"
        self.frames = frames
        self.processor = AutoImageProcessor.from_pretrained(SIGLIP_MODEL)
        self.model = SiglipVisionModel.from_pretrained(SIGLIP_MODEL).eval().to(device)
        self.dim = int(self.model.config.hidden_size)

    def _clip_frames(self, ref: str) -> list[Image.Image]:
        span = parse_span(ref)
        if span is None:
            return [load_image(ref)]
        source, t_start, t_end = span
        frames = sample_frames(source, t_start, t_end, self.frames)
        if not frames:
            return []
        return frames

    @torch.no_grad()
    def _encode(self, frames: list[Image.Image], batch_size: int) -> torch.Tensor:
        """Per-frame embeddings for a flat list of frames, in fixed-size passes."""
        chunks = []
        for start in range(0, len(frames), batch_size):
            batch = frames[start : start + batch_size]
            pixels = self.processor(images=batch, return_tensors="pt")["pixel_values"]
            chunks.append(self.model(pixel_values=pixels.to(self.device)).pooler_output)
        return torch.cat(chunks)

    def _pool_clips(self, clips: list[list[Image.Image]],
                    batch_size: int) -> list[np.ndarray | None]:
        """Mean-pool each clip's frames into one vector, encoding every clip's frames in
        shared passes. Encoding one clip at a time left the GPU idle between clips."""
        flat = [frame for frames in clips for frame in frames]
        if not flat:
            return [None] * len(clips)
        pooled = self._encode(flat, batch_size)

        vectors: list[np.ndarray | None] = []
        offset = 0
        for frames in clips:
            if not frames:
                vectors.append(None)
                continue
            clip = pooled[offset : offset + len(frames)].mean(dim=0)
            clip = torch.nn.functional.normalize(clip, dim=-1)
            vectors.append(clip.cpu().numpy().astype(np.float32))
            offset += len(frames)
        return vectors

    def _try_clip_frames(self, ref: str) -> list[Image.Image]:
        """Frames for one ref, or none if it could not be read. A dead ref reports as an
        empty clip so it embeds as None; letting it raise would lose the whole batch it
        happened to be decoded with."""
        try:
            return self._clip_frames(ref)
        except Exception as error:
            print(f"siglip: {ref} failed to decode: {error}")
            return []

    def _decode_clips(self, refs: list[str]) -> list[list[Image.Image]]:
        """Decode every ref's frames concurrently — the decode is ffmpeg waiting on the
        source, so overlapping them is where a segmentation run gets its time back."""
        workers = min(SIGLIP_DECODE_WORKERS, max(len(refs), 1))
        with ThreadPoolExecutor(max_workers=workers) as pool:
            return list(pool.map(self._try_clip_frames, refs))

    def embed_refs(self, refs: list[str],
                   batch_size: int = SIGLIP_FRAME_BATCH) -> list[np.ndarray | None]:
        """One clip vector per ref, or None where nothing decoded (dead URL, a range
        past the end of the video). None must not become a zero vector: that reads as a
        valid point in the pool and quietly biases every head trained on it."""
        clips = self._decode_clips(refs)
        for ref, frames in zip(refs, clips):
            if not frames:
                print(f"siglip: no frames decoded for {ref} — skipped")
        return self._pool_clips(clips, batch_size)

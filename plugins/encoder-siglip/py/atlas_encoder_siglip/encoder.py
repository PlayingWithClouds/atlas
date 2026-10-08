"""SigLIP encoder: images, video spans (mean of sampled frames) and text queries."""

import os

import numpy as np
from PIL import Image

from atlas_ml.encoder import MediaItem, load_image, sample_clip_frames
from atlas_ml.log import log

DEFAULT_CHECKPOINT = "google/siglip-so400m-patch14-384"
DEFAULT_FRAME_COUNT = 8
FRAME_BATCH_SIZE = 16
# The context length SigLIP was trained with; other paddings degrade embeddings silently.
TEXT_TOKEN_COUNT = 64
VIDEO_KIND = "video"


def checkpoint_name() -> str:
    return os.environ.get("ATLAS_SIGLIP_CHECKPOINT") or DEFAULT_CHECKPOINT


def frame_count_from_environment() -> int:
    raw = os.environ.get("ATLAS_SIGLIP_FRAMES")
    if not raw:
        return DEFAULT_FRAME_COUNT
    try:
        return max(int(raw), 1)
    except ValueError:
        return DEFAULT_FRAME_COUNT


def resolve_device(requested: str) -> str:
    import torch

    if requested == "cuda" and not torch.cuda.is_available():
        log("cuda requested but unavailable; using cpu")
        return "cpu"
    return requested


def is_clip(item: MediaItem) -> bool:
    return item.media_kind == VIDEO_KIND or item.span is not None


def frames_for_items(items: list[MediaItem], frame_count: int) -> list[list[Image.Image]]:
    """Frames per item in item order; an undecodable item gets an empty list."""
    frames: list[list[Image.Image]] = [[] for _ in items]
    clip_positions = [index for index, item in enumerate(items) if is_clip(item)]
    clip_frames = sample_clip_frames([items[index] for index in clip_positions], frame_count)
    for position, decoded in zip(clip_positions, clip_frames):
        frames[position] = decoded
    for index, item in enumerate(items):
        if not is_clip(item):
            frames[index] = load_still(item)
    return frames


def load_still(item: MediaItem) -> list[Image.Image]:
    try:
        return [load_image(item.location)]
    except Exception as error:
        log(f"{item.ref} failed to decode: {error}")
        return []


def pool_frame_features(features: np.ndarray, frame_counts: list[int], dim: int) -> np.ndarray:
    """Mean-pools consecutive rows of `features` per item; items without frames stay zero."""
    pooled = np.zeros((len(frame_counts), dim), dtype=np.float32)
    offset = 0
    for index, count in enumerate(frame_counts):
        if count > 0:
            pooled[index] = features[offset:offset + count].mean(axis=0)
        offset += count
    return pooled


class SiglipEncoder:
    id = "siglip"
    media_kinds = ["image", "video"]

    def __init__(self, device: str):
        import torch
        from transformers import AutoImageProcessor, AutoTokenizer, SiglipModel

        self.torch = torch
        self.device = resolve_device(device)
        self.frame_count = frame_count_from_environment()
        checkpoint = checkpoint_name()
        self.processor = AutoImageProcessor.from_pretrained(checkpoint)
        self.tokenizer = AutoTokenizer.from_pretrained(checkpoint)
        self.model = SiglipModel.from_pretrained(checkpoint).eval().to(self.device)
        self.dim = int(self.model.config.vision_config.hidden_size)

    def embed(self, items: list[MediaItem]) -> np.ndarray:
        frames = frames_for_items(items, self.frame_count)
        flat = [frame for item_frames in frames for frame in item_frames]
        features = self.encode_frames(flat)
        return pool_frame_features(features, [len(item_frames) for item_frames in frames], self.dim)

    def encode_frames(self, frames: list[Image.Image]) -> np.ndarray:
        chunks = []
        with self.torch.no_grad():
            for start in range(0, len(frames), FRAME_BATCH_SIZE):
                batch = frames[start:start + FRAME_BATCH_SIZE]
                pixels = self.processor(images=batch, return_tensors="pt")["pixel_values"]
                output = self.model.vision_model(pixel_values=pixels.to(self.device))
                chunks.append(output.pooler_output.float().cpu().numpy())
        if not chunks:
            return np.zeros((0, self.dim), dtype=np.float32)
        return np.concatenate(chunks, axis=0).astype(np.float32)

    def embed_text(self, texts: list[str]) -> np.ndarray:
        with self.torch.no_grad():
            tokens = self.tokenizer(texts, padding="max_length", max_length=TEXT_TOKEN_COUNT,
                                    truncation=True, return_tensors="pt").to(self.device)
            output = self.model.text_model(**tokens)
        return output.pooler_output.float().cpu().numpy().astype(np.float32)


def create_encoder(device: str) -> SiglipEncoder:
    return SiglipEncoder(device)

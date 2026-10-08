"""JoyTag multi-label tagger (ViT-B/16, 448px, ~5800 Danbooru tags) served as an atlas_ml tagger."""

import os
import sys
import urllib.request

import numpy as np
from PIL import Image

from atlas_ml.encoder import MediaItem, load_image
from atlas_ml.log import log

HUGGING_FACE_BASE = "https://huggingface.co/fancyfeast/joytag/resolve/main"
MODELS_SOURCE_URL = "https://raw.githubusercontent.com/fpgaminer/joytag/main/Models.py"
WEIGHT_FILES = {
    "config.json": f"{HUGGING_FACE_BASE}/config.json",
    "top_tags.txt": f"{HUGGING_FACE_BASE}/top_tags.txt",
    "model.safetensors": f"{HUGGING_FACE_BASE}/model.safetensors",
    "Models.py": MODELS_SOURCE_URL,
}
DOWNLOAD_TIMEOUT_SECONDS = 600
MINIMUM_FILE_BYTES = 100
BATCH_SIZE = 8
# CLIP normalization.
MEAN = np.array([0.48145466, 0.4578275, 0.40821073], dtype=np.float32)
STANDARD_DEVIATION = np.array([0.26862954, 0.26130258, 0.27577711], dtype=np.float32)


def pad_to_square(image: Image.Image) -> Image.Image:
    """Centers the image on a white square whose side is the longest edge."""
    image = image.convert("RGB")
    side = max(image.size)
    padded = Image.new("RGB", (side, side), (255, 255, 255))
    padded.paste(image, ((side - image.size[0]) // 2, (side - image.size[1]) // 2))
    return padded


def preprocess(image: Image.Image, size: int) -> np.ndarray:
    """White-pads, resizes and CLIP-normalizes into a float32 array of shape (3, size, size)."""
    padded = pad_to_square(image)
    if padded.size != (size, size):
        padded = padded.resize((size, size), Image.BICUBIC)
    pixels = np.asarray(padded, dtype=np.float32) / 255.0
    normalized = (pixels - MEAN) / STANDARD_DEVIATION
    return np.ascontiguousarray(normalized.transpose(2, 0, 1))


def scores_by_tag(tags: list[str], probabilities: np.ndarray) -> dict[str, float]:
    return {tag: float(probability) for tag, probability in zip(tags, probabilities)}


def cache_directory() -> str:
    """Weights live in ATLAS_JOYTAG_WEIGHTS (shareable with the encoder) or the plugin cache."""
    shared = os.environ.get("ATLAS_JOYTAG_WEIGHTS")
    if shared:
        return shared
    configured = os.environ.get("ATLAS_PLUGIN_CACHE")
    if configured:
        return configured
    return os.path.expanduser("~/.cache/atlas/tagger-joytag")


def download(url: str, destination: str) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    temporary = destination + ".part"
    with urllib.request.urlopen(request, timeout=DOWNLOAD_TIMEOUT_SECONDS) as response:
        with open(temporary, "wb") as handle:
            handle.write(response.read())
    os.replace(temporary, destination)


def ensure_weights(directory: str) -> None:
    os.makedirs(directory, exist_ok=True)
    for name, url in WEIGHT_FILES.items():
        path = os.path.join(directory, name)
        if os.path.exists(path) and os.path.getsize(path) > MINIMUM_FILE_BYTES:
            continue
        log(f"downloading {name}")
        download(url, path)


def read_tags(directory: str) -> list[str]:
    with open(os.path.join(directory, "top_tags.txt")) as handle:
        return [line.strip() for line in handle if line.strip()]


class JoytagTagger:
    id = "joytag"
    media_kinds = ["image"]

    def __init__(self, device: str):
        import torch

        if device == "cuda" and not torch.cuda.is_available():
            log("cuda requested but unavailable; using cpu")
            device = "cpu"
        self.torch = torch
        self.device = device
        directory = cache_directory()
        ensure_weights(directory)
        if directory not in sys.path:
            sys.path.insert(0, directory)
        from Models import VisionModel

        self.model = VisionModel.load_model(directory, device=device).eval().to(device)
        self.image_size = int(self.model.image_size)
        self.tags = read_tags(directory)

    def tag(self, items: list[MediaItem]) -> list[dict[str, float]]:
        tensors = [self.prepare(item) for item in items]
        rows: list[dict[str, float]] = [{} for _ in items]
        decoded = [index for index, tensor in enumerate(tensors) if tensor is not None]
        for start in range(0, len(decoded), BATCH_SIZE):
            positions = decoded[start:start + BATCH_SIZE]
            probabilities = self.run_batch([tensors[position] for position in positions])
            for position, row in zip(positions, probabilities):
                rows[position] = scores_by_tag(self.tags, row)
        return rows

    def prepare(self, item: MediaItem) -> np.ndarray | None:
        try:
            return preprocess(load_image(item.location), self.image_size)
        except Exception as error:
            log(f"{item.ref} failed to decode: {error}")
            return None

    def run_batch(self, arrays: list[np.ndarray]) -> np.ndarray:
        batch = self.torch.from_numpy(np.stack(arrays)).to(self.device)
        with self.torch.no_grad():
            output = self.model({"image": batch})
        return output["tags"].sigmoid().float().cpu().numpy()


def create_tagger(device: str) -> JoytagTagger:
    return JoytagTagger(device)

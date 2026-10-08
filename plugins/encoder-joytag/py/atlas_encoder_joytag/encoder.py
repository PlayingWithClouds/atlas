"""JoyTag vision features (ViT-B/16, 448px) used as image embeddings."""

import os
import sys

import numpy as np
import requests
from PIL import Image

from atlas_ml.encoder import MediaItem, load_image
from atlas_ml.log import log

HUGGING_FACE_BASE = "https://huggingface.co/fancyfeast/joytag/resolve/main"
MODELS_SOURCE_URL = "https://raw.githubusercontent.com/fpgaminer/joytag/main/Models.py"
WEIGHT_FILES = {
    "config.json": f"{HUGGING_FACE_BASE}/config.json",
    "model.safetensors": f"{HUGGING_FACE_BASE}/model.safetensors",
    "Models.py": MODELS_SOURCE_URL,
}
DOWNLOAD_TIMEOUT_SECONDS = 600
MINIMUM_FILE_BYTES = 100
IMAGE_SIZE = 448
EMBEDDING_DIM = 768
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


def preprocess(image: Image.Image, size: int = IMAGE_SIZE) -> np.ndarray:
    """White-pads, resizes and CLIP-normalizes into a float32 array of shape (3, size, size)."""
    padded = pad_to_square(image)
    if padded.size != (size, size):
        padded = padded.resize((size, size), Image.BICUBIC)
    pixels = np.asarray(padded, dtype=np.float32) / 255.0
    normalized = (pixels - MEAN) / STANDARD_DEVIATION
    return np.ascontiguousarray(normalized.transpose(2, 0, 1))


def cache_directory() -> str:
    configured = os.environ.get("ATLAS_PLUGIN_CACHE")
    if configured:
        return configured
    return os.path.expanduser("~/.cache/atlas/encoder-joytag")


def download(url: str, destination: str) -> None:
    response = requests.get(url, headers={"User-Agent": "Mozilla/5.0"},
                            timeout=DOWNLOAD_TIMEOUT_SECONDS)
    response.raise_for_status()
    temporary = destination + ".part"
    with open(temporary, "wb") as handle:
        handle.write(response.content)
    os.replace(temporary, destination)


def ensure_weights(directory: str) -> None:
    os.makedirs(directory, exist_ok=True)
    for name, url in WEIGHT_FILES.items():
        path = os.path.join(directory, name)
        if os.path.exists(path) and os.path.getsize(path) > MINIMUM_FILE_BYTES:
            continue
        log(f"downloading {name}")
        download(url, path)


class JoytagEncoder:
    id = "joytag"
    dim = EMBEDDING_DIM
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

    def embed(self, items: list[MediaItem]) -> np.ndarray:
        tensors = [self.prepare(item) for item in items]
        vectors = np.zeros((len(items), self.dim), dtype=np.float32)
        decoded = [index for index, tensor in enumerate(tensors) if tensor is not None]
        for start in range(0, len(decoded), BATCH_SIZE):
            positions = decoded[start:start + BATCH_SIZE]
            vectors[positions] = self.encode_batch([tensors[position] for position in positions])
        return vectors

    def prepare(self, item: MediaItem) -> np.ndarray | None:
        try:
            return preprocess(load_image(item.location), self.image_size)
        except Exception as error:
            log(f"{item.ref} failed to decode: {error}")
            return None

    def encode_batch(self, arrays: list[np.ndarray]) -> np.ndarray:
        batch = self.torch.from_numpy(np.stack(arrays)).to(self.device)
        with self.torch.no_grad():
            output = self.model({"image": batch}, return_embeddings=True)
        return output["embeddings"].float().cpu().numpy()


def create_encoder(device: str) -> JoytagEncoder:
    return JoytagEncoder(device)

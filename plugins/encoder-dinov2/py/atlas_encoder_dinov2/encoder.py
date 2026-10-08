"""DINOv2 image encoder through timm."""

import os

import numpy as np
from PIL import Image

from atlas_ml.encoder import MediaItem, load_image
from atlas_ml.log import log

DEFAULT_VARIANT = "vit_small_patch14_dinov2.lvd142m"
INPUT_SIZE = 224
BATCH_SIZE = 16


def variant_name() -> str:
    return os.environ.get("ATLAS_DINOV2_MODEL") or DEFAULT_VARIANT


def encoder_id(variant: str) -> str:
    """Vector pools are cached per id, so each variant needs its own."""
    return "dinov2-" + variant.replace("/", "-")


def load_images(items: list[MediaItem]) -> list[Image.Image | None]:
    images: list[Image.Image | None] = []
    for item in items:
        try:
            images.append(load_image(item.location))
        except Exception as error:
            log(f"{item.ref} failed to decode: {error}")
            images.append(None)
    return images


class Dinov2Encoder:
    media_kinds = ["image"]

    def __init__(self, device: str):
        import timm
        import torch
        from timm.data import create_transform, resolve_data_config

        self.torch = torch
        if device == "cuda" and not torch.cuda.is_available():
            log("cuda requested but unavailable; using cpu")
            device = "cpu"
        self.device = device
        variant = variant_name()
        self.id = encoder_id(variant)
        # patch14 position embeddings are interpolated for the smaller grid.
        self.model = timm.create_model(variant, pretrained=True, num_classes=0,
                                       img_size=INPUT_SIZE).eval().to(device)
        config = resolve_data_config({}, model=self.model)
        config["input_size"] = (3, INPUT_SIZE, INPUT_SIZE)
        self.transform = create_transform(**config)
        self.dim = int(self.model.num_features)

    def embed(self, items: list[MediaItem]) -> np.ndarray:
        images = load_images(items)
        vectors = np.zeros((len(items), self.dim), dtype=np.float32)
        decoded = [index for index, image in enumerate(images) if image is not None]
        for start in range(0, len(decoded), BATCH_SIZE):
            positions = decoded[start:start + BATCH_SIZE]
            vectors[positions] = self.encode_batch([images[position] for position in positions])
        return vectors

    def encode_batch(self, images: list[Image.Image]) -> np.ndarray:
        batch = self.torch.stack([self.transform(image) for image in images]).to(self.device)
        with self.torch.no_grad():
            features = self.model(batch)
        return features.float().cpu().numpy()


def create_encoder(device: str) -> Dinov2Encoder:
    return Dinov2Encoder(device)

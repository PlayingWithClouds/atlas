"""JoyTag multi-label tagger.

Loads the full JoyTag model (ViT-B/16, 448px, ~5800 Danbooru tags, trained on
danbooru + photographic imagery) and returns per-image tag probabilities. The
weights live in the shared ~/.cache/atlas/joytag directory, so nothing is
downloaded twice when the model plugin already fetched them for its embedder.
"""

import io
import os
import urllib.request

import numpy as np
import torch
import torchvision.transforms.functional as TVF
from PIL import Image

JOYTAG_DIR = os.path.expanduser("~/.cache/atlas/joytag")
_JOYTAG_HF = "https://huggingface.co/fancyfeast/joytag/resolve/main"
_JOYTAG_MODELS_PY = "https://raw.githubusercontent.com/fpgaminer/joytag/main/Models.py"
# CLIP normalization; images are white-padded to square then resized to 448.
_JOYTAG_MEAN = [0.48145466, 0.4578275, 0.40821073]
_JOYTAG_STD = [0.26862954, 0.26130258, 0.27577711]

# pornpics and similar CDNs reject requests without a browser-like UA / referer.
_FETCH_HEADERS = {"User-Agent": "Mozilla/5.0", "Referer": "https://www.pornpics.com/"}


def load_image(ref: str) -> Image.Image:
    if ref.startswith("http://") or ref.startswith("https://"):
        request = urllib.request.Request(ref, headers=_FETCH_HEADERS)
        with urllib.request.urlopen(request, timeout=30) as response:
            data = response.read()
        return Image.open(io.BytesIO(data)).convert("RGB")
    return Image.open(ref).convert("RGB")


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


class JoyTagTagger:
    def __init__(self, device: str | None = None):
        import sys

        _ensure_joytag()
        if JOYTAG_DIR not in sys.path:
            sys.path.insert(0, JOYTAG_DIR)
        from Models import VisionModel

        if device is None:
            device = "cuda" if torch.cuda.is_available() else "cpu"
        self.device = device
        self.model = VisionModel.load_model(JOYTAG_DIR, device=device).eval().to(device)
        self.image_size = int(self.model.image_size)
        with open(os.path.join(JOYTAG_DIR, "top_tags.txt")) as handle:
            self.tags = [line.strip() for line in handle if line.strip()]

    def _prepare(self, image: Image.Image) -> torch.Tensor:
        image = image.convert("RGB")
        largest = max(image.size)
        padded = Image.new("RGB", (largest, largest), (255, 255, 255))
        padded.paste(image, ((largest - image.size[0]) // 2, (largest - image.size[1]) // 2))
        if largest != self.image_size:
            padded = padded.resize((self.image_size, self.image_size), Image.BICUBIC)
        tensor = TVF.pil_to_tensor(padded) / 255.0
        return TVF.normalize(tensor, mean=_JOYTAG_MEAN, std=_JOYTAG_STD)

    @torch.no_grad()
    def predict_refs(self, refs: list[str], batch_size: int = 8) -> np.ndarray:
        """Returns sigmoid probabilities with shape [len(refs), len(self.tags)]."""
        rows: list[np.ndarray] = []
        batch: list[torch.Tensor] = []
        for ref in refs:
            batch.append(self._prepare(load_image(ref)))
            if len(batch) == batch_size:
                rows.append(self._run(batch))
                batch = []
        if batch:
            rows.append(self._run(batch))
        if not rows:
            return np.zeros((0, len(self.tags)), dtype=np.float32)
        return np.concatenate(rows, axis=0)

    def _run(self, batch: list[torch.Tensor]) -> np.ndarray:
        tensor = torch.stack(batch).to(self.device)
        out = self.model({"image": tensor})
        return out["tags"].sigmoid().cpu().numpy().astype(np.float32)

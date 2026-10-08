"""Registry of classifier-head factories, keyed by name.

A head is built per (project, class list). Its contract:
`fit(features, targets)`, `predict(features) -> probabilities`, and `trained: bool`.
"""

from typing import Callable, Protocol

import numpy as np


class Head(Protocol):
    trained: bool

    def fit(self, features: np.ndarray, targets: np.ndarray) -> None: ...

    def predict(self, features: np.ndarray) -> np.ndarray: ...


HeadFactory = Callable[[list[str], str], Head]

HEAD_FACTORIES: dict[str, HeadFactory] = {}


def register_head(name: str, factory: HeadFactory) -> None:
    HEAD_FACTORIES[name] = factory


def create_head(name: str, classes: list[str], device: str) -> Head:
    factory = HEAD_FACTORIES.get(name)
    if factory is None:
        known = ", ".join(sorted(HEAD_FACTORIES))
        raise ValueError(f"unknown head '{name}' (registered: {known})")
    return factory(classes, device)


class LinearProbeHead:
    """Multi-label linear probe: one Linear layer trained full-batch with BCE.

    Per-class `pos_weight` compensates for imbalance, so rare classes are not drowned by
    the negative majority.
    """

    def __init__(self, classes: list[str], device: str = "cpu"):
        self.classes = classes
        self.device = device
        self.linear = None
        self.trained = False

    def fit(self, features: np.ndarray, targets: np.ndarray,
            steps: int = 300, learning_rate: float = 0.05) -> None:
        import torch

        if features.shape[0] == 0:
            self.trained = False
            return
        feature_tensor = torch.as_tensor(features, dtype=torch.float32, device=self.device)
        target_tensor = torch.as_tensor(targets, dtype=torch.float32, device=self.device)
        positives = target_tensor.sum(dim=0)
        negatives = target_tensor.shape[0] - positives
        positive_weight = torch.clamp(negatives / torch.clamp(positives, min=1.0), max=100.0)

        linear = torch.nn.Linear(features.shape[1], len(self.classes)).to(self.device)
        optimizer = torch.optim.Adam(linear.parameters(), lr=learning_rate, weight_decay=1e-4)
        loss_function = torch.nn.BCEWithLogitsLoss(pos_weight=positive_weight)
        linear.train()
        for _ in range(steps):
            optimizer.zero_grad()
            loss_function(linear(feature_tensor), target_tensor).backward()
            optimizer.step()
        linear.eval()
        self.linear = linear
        self.trained = True

    def predict(self, features: np.ndarray) -> np.ndarray:
        import torch

        if not self.trained or self.linear is None:
            return np.zeros((features.shape[0], len(self.classes)), dtype=np.float32)
        with torch.no_grad():
            feature_tensor = torch.as_tensor(features, dtype=torch.float32, device=self.device)
            probabilities = torch.sigmoid(self.linear(feature_tensor))
            return probabilities.cpu().numpy().astype(np.float32)


register_head("linear-probe", lambda classes, device: LinearProbeHead(classes, device))

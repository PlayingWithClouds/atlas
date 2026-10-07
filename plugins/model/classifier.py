"""Multi-label classifier head.

One logistic regression per class (one-vs-rest). Trains on cached embeddings,
so refitting after each new label is milliseconds. Classes without both a
positive and negative example fall back to a constant prior.
"""

import numpy as np
from sklearn.linear_model import LogisticRegression


class MultiLabelHead:
    def __init__(self, classes: list[str]):
        self.classes = classes
        self.models: dict[str, tuple[str, object]] = {}
        self.trained = False

    def fit(self, X: np.ndarray, Y: np.ndarray) -> None:
        """X: (n, dim) embeddings. Y: (n, num_classes) binary labels."""
        if X.shape[0] == 0:
            self.trained = False
            return

        for index, class_name in enumerate(self.classes):
            column = Y[:, index]
            positives = int(column.sum())
            if positives == 0 or positives == len(column):
                prior = positives / len(column)
                self.models[class_name] = ("const", prior)
                continue
            # class_weight='balanced' weights examples inversely to class frequency,
            # so rare tags aren't drowned out by the negative majority (the standard
            # fix for imbalanced linear probes on frozen features).
            model = LogisticRegression(max_iter=1000, C=1.0, class_weight="balanced")
            model.fit(X, column)
            self.models[class_name] = ("model", model)

        self.trained = True

    def predict(self, X: np.ndarray) -> np.ndarray:
        probabilities = np.zeros((X.shape[0], len(self.classes)), dtype=np.float32)
        for index, class_name in enumerate(self.classes):
            kind, value = self.models.get(class_name, ("const", 0.0))
            if kind == "const":
                probabilities[:, index] = value
            else:
                probabilities[:, index] = value.predict_proba(X)[:, 1]
        return probabilities


def uncertainty_scores(probabilities: np.ndarray) -> np.ndarray:
    """Higher = more uncertain. Sum of per-class distance-from-decision-boundary."""
    return np.minimum(probabilities, 1.0 - probabilities).sum(axis=1)


class TorchHead:
    """Multi-label linear probe trained on the GPU.

    A drop-in replacement for MultiLabelHead that trains a single Linear layer with
    BCEWithLogitsLoss (per-class pos_weight for imbalance) in a few hundred full-batch
    steps. On a GPU this refits the whole pool in a fraction of a second, instead of
    fitting 72 sklearn logistic regressions on the CPU (which saturates every core).
    """

    def __init__(self, classes: list[str], device: str | None = None):
        import torch

        self.classes = classes
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        self.linear = None
        self.trained = False

    def fit(self, X: np.ndarray, Y: np.ndarray, steps: int = 300, lr: float = 0.05) -> None:
        import torch

        if X.shape[0] == 0:
            self.trained = False
            return
        device = self.device
        Xt = torch.as_tensor(X, dtype=torch.float32, device=device)
        Yt = torch.as_tensor(Y, dtype=torch.float32, device=device)
        positives = Yt.sum(dim=0)
        negatives = Yt.shape[0] - positives
        pos_weight = torch.clamp(negatives / torch.clamp(positives, min=1.0), max=100.0)

        linear = torch.nn.Linear(X.shape[1], len(self.classes)).to(device)
        optimizer = torch.optim.Adam(linear.parameters(), lr=lr, weight_decay=1e-4)
        loss_fn = torch.nn.BCEWithLogitsLoss(pos_weight=pos_weight)
        linear.train()
        for _ in range(steps):
            optimizer.zero_grad()
            loss = loss_fn(linear(Xt), Yt)
            loss.backward()
            optimizer.step()
        linear.eval()
        self.linear = linear
        self.trained = True

    def predict(self, X: np.ndarray) -> np.ndarray:
        import torch

        if not self.trained or self.linear is None:
            return np.zeros((X.shape[0], len(self.classes)), dtype=np.float32)
        with torch.no_grad():
            Xt = torch.as_tensor(X, dtype=torch.float32, device=self.device)
            probabilities = torch.sigmoid(self.linear(Xt))
            return probabilities.cpu().numpy().astype(np.float32)

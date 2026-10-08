"""Ranking metrics for per-class evaluation (numpy only)."""

import numpy as np


def precision_recall_points(labels: np.ndarray, scores: np.ndarray):
    """Precision and recall at each distinct score threshold, highest threshold first."""
    order = np.argsort(-scores, kind="stable")
    sorted_scores = scores[order]
    sorted_labels = labels[order]
    true_positives = np.cumsum(sorted_labels)
    predicted = np.arange(1, len(labels) + 1)
    last_of_group = np.r_[np.flatnonzero(np.diff(sorted_scores)), len(labels) - 1]
    precision = true_positives[last_of_group] / predicted[last_of_group]
    recall = true_positives[last_of_group] / max(int(labels.sum()), 1)
    return precision, recall, sorted_scores[last_of_group]


def average_precision(labels: np.ndarray, scores: np.ndarray) -> float:
    precision, recall, _ = precision_recall_points(labels, scores)
    previous_recall = np.r_[0.0, recall[:-1]]
    return float(np.sum((recall - previous_recall) * precision))


def best_f1_point(labels: np.ndarray, scores: np.ndarray) -> dict:
    precision, recall, thresholds = precision_recall_points(labels, scores)
    f1_curve = 2 * precision * recall / (precision + recall + 1e-9)
    best = int(f1_curve.argmax())
    return {
        "f1": float(f1_curve[best]),
        "precision": float(precision[best]),
        "recall": float(recall[best]),
        "threshold": float(thresholds[best]),
    }


def fold_assignments(count: int, folds: int, seed: int = 0) -> np.ndarray:
    """Shuffled, balanced fold index for each of `count` rows."""
    generator = np.random.RandomState(seed)
    permutation = generator.permutation(count)
    assignments = np.zeros(count, dtype=int)
    assignments[permutation] = np.arange(count) % folds
    return assignments

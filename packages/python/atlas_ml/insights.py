"""Cross-validated per-class quality estimates for a labeled pool."""

from typing import Callable

import numpy as np

from atlas_ml.heads import Head
from atlas_ml.metrics import average_precision, best_f1_point, fold_assignments
from atlas_ml.vectors import deduplicate_rows

MIN_ROWS_FOR_INSIGHTS = 8
MIN_PER_CLASS = 4  # positives AND negatives needed to evaluate a class
MAX_FOLDS = 5

HeadBuilder = Callable[[list[str]], Head]


def out_of_fold_probabilities(features: np.ndarray, targets: np.ndarray, names: list[str],
                              build_head: HeadBuilder, folds: int) -> np.ndarray:
    assignments = fold_assignments(len(features), folds)
    probabilities = np.zeros_like(targets, dtype=np.float32)
    for fold in range(folds):
        validation = assignments == fold
        head = build_head(names)
        head.fit(features[~validation], targets[~validation])
        probabilities[validation] = head.predict(features[validation])
    return probabilities


def evaluate_class(name: str, labels: np.ndarray, scores: np.ndarray, folds: int) -> dict:
    positives = int(labels.sum())
    negatives = len(labels) - positives
    entry = {"name": name, "support": positives, "negatives": negatives, "evaluated": False}
    if positives < MIN_PER_CLASS or negatives < MIN_PER_CLASS:
        return entry
    best = best_f1_point(labels, scores)
    entry.update(
        averagePrecision=round(average_precision(labels, scores), 3),
        f1=round(best["f1"], 3),
        precision=round(best["precision"], 3),
        recall=round(best["recall"], 3),
        threshold=round(best["threshold"], 3),
        baseRate=round(positives / len(labels), 3),
        folds=folds,
        evaluated=True,
    )
    return entry


def sort_key(entry: dict):
    return (not entry["evaluated"], entry.get("averagePrecision", 1.0), -entry["support"])


def compute_insights(features: np.ndarray, targets: np.ndarray, names: list[str],
                     pool_size: int, build_head: HeadBuilder) -> dict:
    """Out-of-fold evaluation. Identical vectors are collapsed first: a duplicate that
    lands in both train and validation folds would inflate every metric."""
    unique_features, unique_targets = deduplicate_rows(features, targets)
    if len(unique_features) < MIN_ROWS_FOR_INSIGHTS or not names:
        return {"poolSize": pool_size, "classes": []}
    folds = min(MAX_FOLDS, len(unique_features))
    probabilities = out_of_fold_probabilities(
        unique_features, unique_targets, names, build_head, folds)

    entries = []
    for index, name in enumerate(names):
        labels = unique_targets[:, index].astype(int)
        entries.append(evaluate_class(name, labels, probabilities[:, index], folds))
    entries.sort(key=sort_key)
    return {"poolSize": pool_size, "classes": entries}

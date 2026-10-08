"""Pure numpy helpers over embedding matrices."""

import numpy as np


def unit_rows(matrix: np.ndarray) -> np.ndarray:
    """L2-normalizes each row, leaving zero rows alone so a dot product stays a cosine."""
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return matrix / norms


def usable_rows(matrix: np.ndarray) -> np.ndarray:
    """Boolean mask of rows that are finite and non-zero."""
    finite = np.isfinite(matrix).all(axis=1)
    nonzero = np.linalg.norm(np.nan_to_num(matrix), axis=1) > 0
    return finite & nonzero


def cosine(first: np.ndarray | None, second: np.ndarray | None) -> float:
    if first is None or second is None:
        return 0.0
    norms = float(np.linalg.norm(first) * np.linalg.norm(second))
    if norms == 0:
        return 0.0
    return round(float(np.dot(first, second) / norms), 4)


def greedy_cosine_groups(matrix: np.ndarray, threshold: float) -> list[list[int]]:
    """Groups row indices; each group is seeded by the first unused row and collects every
    unused row at or above `threshold` cosine similarity to that seed."""
    unit = unit_rows(matrix)
    used = np.zeros(len(unit), dtype=bool)
    groups = []
    for seed in range(len(unit)):
        if used[seed]:
            continue
        similarities = unit[seed] @ unit.T
        members = np.flatnonzero((~used) & (similarities >= threshold))
        used[members] = True
        groups.append([int(member) for member in members])
    return groups


def deduplicate_rows(matrix: np.ndarray, targets: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Collapses rows with byte-identical vectors, taking the union of their targets."""
    first_row_by_key: dict[bytes, int] = {}
    kept_rows: list[int] = []
    merged_targets: list[np.ndarray] = []
    for row in range(len(matrix)):
        key = matrix[row].tobytes()
        position = first_row_by_key.get(key)
        if position is None:
            first_row_by_key[key] = len(kept_rows)
            kept_rows.append(row)
            merged_targets.append(targets[row].copy())
            continue
        merged_targets[position] = np.maximum(merged_targets[position], targets[row])
    return matrix[kept_rows], np.array(merged_targets, dtype=np.float32).reshape(
        len(kept_rows), targets.shape[1])

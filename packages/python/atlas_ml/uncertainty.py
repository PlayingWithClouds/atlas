"""Registry of uncertainty strategies: probabilities (n, classes) -> scores (n,).

Higher means more informative to label next.
"""

from typing import Callable

import numpy as np

Strategy = Callable[[np.ndarray], np.ndarray]

STRATEGIES: dict[str, Strategy] = {}


def register_strategy(name: str, strategy: Strategy) -> None:
    STRATEGIES[name] = strategy


def get_strategy(name: str) -> Strategy:
    strategy = STRATEGIES.get(name)
    if strategy is None:
        known = ", ".join(sorted(STRATEGIES))
        raise ValueError(f"unknown uncertainty strategy '{name}' (registered: {known})")
    return strategy


def margin_sum(probabilities: np.ndarray) -> np.ndarray:
    """Sum over classes of the distance to the decision boundary."""
    return np.minimum(probabilities, 1.0 - probabilities).sum(axis=1)


register_strategy("margin-sum", margin_sum)

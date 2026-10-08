"""Tagger interface and service: modules that score media against a fixed tag vocabulary.

A tagger module exposes `create_tagger(device) -> Tagger`. The worker serves it as the
`tag` RPC method. Unlike an encoder it keeps no vectors, pools or heads.
"""

from typing import Protocol, runtime_checkable

from atlas_ml.encoder import MediaItem, media_item_from_json

SCORE_DECIMALS = 4


@runtime_checkable
class Tagger(Protocol):
    """`tag` returns one {tag: probability} dict per item, empty for undecodable items."""

    id: str
    media_kinds: list[str]

    def tag(self, items: list[MediaItem]) -> list[dict[str, float]]: ...


class TaggerService:
    def __init__(self, tagger: Tagger):
        self.tagger = tagger

    def describe(self) -> dict:
        return {"id": self.tagger.id, "mediaKinds": list(self.tagger.media_kinds), "kind": "tagger"}

    def tag(self, items: list[dict], min_score: float = 0.0) -> list[dict[str, float]]:
        """Scores every item; tags below `min_score` are dropped to keep replies small."""
        media_items = [media_item_from_json(payload) for payload in items]
        scored = self.tagger.tag(media_items)
        if len(scored) != len(media_items):
            raise ValueError(f"tagger returned {len(scored)} rows for {len(media_items)} items")
        return [self.keep_confident(scores, min_score) for scores in scored]

    def keep_confident(self, scores: dict[str, float], min_score: float) -> dict[str, float]:
        return {tag: round(float(score), SCORE_DECIMALS)
                for tag, score in scores.items() if score >= min_score}

    def close(self) -> None:
        close = getattr(self.tagger, "close", None)
        if close is not None:
            close()

import time
from collections.abc import Sequence

import numpy as np

from app.services.embeddings import DIM, EmbeddingError, EmbeddingFailure
from app.services.ml import MlEntity


def make_entity(
    name: str = "orders", n: int = 40, *, outlier: bool = True, constant: bool = False, seed: int = 0
) -> MlEntity:
    rng = np.random.default_rng(seed)
    rows = []
    for i in range(n):
        qty = "5" if constant else str(int(rng.integers(8, 12)))
        price = "10.00" if constant else f"{rng.uniform(9, 11):.2f}"
        rows.append((f"K{i:04d}", qty, price))
    if outlier and not constant and n >= 3:
        rows[-1] = (rows[-1][0], "900000", "-5000.00")
    return MlEntity(
        name=name,
        fields=(("key", "string"), ("qty", "integer"), ("price", "decimal")),
        rows=tuple(rows),
        row_numbers=tuple(range(1, n + 1)),
    )


class RaisingProvider:
    name = "hash"
    dim = DIM

    def __init__(self, reason: EmbeddingFailure) -> None:
        self.reason = reason

    def embed(self, texts: Sequence[str], *, deadline: float) -> np.ndarray:
        raise EmbeddingError(self.reason)


class BadShapeProvider:
    name = "hash"
    dim = DIM

    def __init__(self, kind: str) -> None:
        self.kind = kind

    def embed(self, texts: Sequence[str], *, deadline: float) -> np.ndarray:
        n = len(texts)
        if self.kind == "dim":
            return np.ones((n, DIM - 1), dtype=np.float32)
        if self.kind == "nan":
            return np.full((n, DIM), np.nan, dtype=np.float32)
        if self.kind == "inf":
            return np.full((n, DIM), np.inf, dtype=np.float32)
        return np.ones((n, DIM), dtype=np.float32)


def far_deadline() -> float:
    return time.monotonic() + 600

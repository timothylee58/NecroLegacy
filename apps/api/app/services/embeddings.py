import hashlib
import logging
import time
from collections.abc import Sequence
from typing import Literal, Protocol

import httpx
import numpy as np

from app.core.config import Settings
from app.services.sanitizer import sanitize_cell

logger = logging.getLogger("necro.embeddings")

DIM = 384
VALUE_MAX = 200
API_BATCH = 256
API_TIMEOUT_SECONDS = 20.0
EmbeddingFailure = Literal["provider_error", "provider_timeout", "invalid_embedding"]


class EmbeddingError(Exception):
    def __init__(self, reason: EmbeddingFailure) -> None:
        super().__init__(reason)
        self.reason: EmbeddingFailure = reason


class EmbeddingProvider(Protocol):
    name: Literal["hash", "api"]
    dim: int

    def embed(self, texts: Sequence[str], *, deadline: float) -> np.ndarray: ...


def record_text(entity: str, fields: Sequence[str], values: Sequence[str]) -> str:
    parts = []
    for i, name in enumerate(fields):
        value = sanitize_cell(values[i] if i < len(values) else "")[:VALUE_MAX]
        parts.append(f"{name}={value or '<empty>'}")
    return f"{entity} | " + "; ".join(parts)


def _shape(value: str) -> str:
    out: list[str] = []
    for ch in value:
        mapped = "9" if ch.isdigit() else "a" if ch.isalpha() else ch
        if not out or out[-1] != mapped or mapped not in "9a":
            out.append(mapped)
    return "".join(out)


def _tokens(text: str) -> list[str]:
    _, _, body = text.partition(" | ")
    tokens: list[str] = []
    for piece in body.split("; ") if body else []:
        field, sep, value = piece.partition("=")
        if not sep:
            continue
        field, value = field.lower(), value.lower()
        tokens.append(f"kv:{field}={value}")
        tokens.append(f"v:{value}")
        tokens.extend(f"g:{value[i : i + 3]}" for i in range(max(0, len(value) - 2)))
        tokens.append(f"s:{field}:{_shape(value)}")
    return tokens


def _bucket(token: str) -> tuple[int, float]:
    # blake2b, not hash(): Python's str hash is salted per process and would break cross-process determinism.
    n = int.from_bytes(hashlib.blake2b(token.encode(), digest_size=8).digest(), "big")
    return n % DIM, -1.0 if (n >> 63) & 1 else 1.0


def _l2(matrix: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    safe = np.where(norms > 0, norms, 1.0)
    return (matrix / safe).astype(np.float32)


class HashEmbeddingProvider:
    name: Literal["hash", "api"] = "hash"
    dim = DIM

    def embed(self, texts: Sequence[str], *, deadline: float) -> np.ndarray:
        out = np.zeros((len(texts), DIM), dtype=np.float64)
        for i, text in enumerate(texts):
            if i % 1024 == 0 and time.monotonic() > deadline:
                raise EmbeddingError("provider_timeout")
            for token in _tokens(text):
                bucket, sign = _bucket(token)
                out[i, bucket] += sign
        return _l2(np.sign(out) * np.log1p(np.abs(out)))


class ApiEmbeddingProvider:
    name: Literal["hash", "api"] = "api"
    dim = DIM

    def __init__(self, url: str, api_key: str, model: str, client: httpx.Client | None = None) -> None:
        self._url = url
        self._key = api_key
        self._model = model
        self._client = client

    def _post(self, client: httpx.Client, batch: Sequence[str]) -> list[object]:
        try:
            response = client.post(
                self._url,
                json={"model": self._model, "input": list(batch)},
                headers={"Authorization": f"Bearer {self._key}"},
                timeout=API_TIMEOUT_SECONDS,
            )
            response.raise_for_status()
            body = response.json()
            return [item["embedding"] for item in body["data"]]
        except httpx.TimeoutException:
            raise EmbeddingError("provider_timeout") from None
        except httpx.HTTPError:
            raise EmbeddingError("provider_error") from None
        except (ValueError, KeyError, TypeError):
            raise EmbeddingError("invalid_embedding") from None

    def embed(self, texts: Sequence[str], *, deadline: float) -> np.ndarray:
        client = self._client or httpx.Client()
        rows: list[object] = []
        try:
            for start in range(0, len(texts), API_BATCH):
                if time.monotonic() > deadline:
                    raise EmbeddingError("provider_timeout")
                batch = texts[start : start + API_BATCH]
                vectors = self._post(client, batch)
                if len(vectors) != len(batch):
                    raise EmbeddingError("invalid_embedding")
                rows.extend(vectors)
        finally:
            if self._client is None:
                client.close()
        if not rows:
            return np.zeros((0, DIM), dtype=np.float32)
        if any(not isinstance(v, list) or len(v) != DIM for v in rows):
            raise EmbeddingError("invalid_embedding")
        try:
            matrix = np.asarray(rows, dtype=np.float64)
        except (ValueError, TypeError):
            raise EmbeddingError("invalid_embedding") from None
        if not np.isfinite(matrix).all():
            raise EmbeddingError("invalid_embedding")
        return _l2(matrix)


def get_provider(settings: Settings) -> EmbeddingProvider:
    if settings.embedding_provider != "api":
        return HashEmbeddingProvider()
    missing = [
        var
        for var, value in (
            ("EMBEDDING_API_URL", settings.embedding_api_url),
            ("EMBEDDING_API_KEY", settings.embedding_api_key),
            ("EMBEDDING_MODEL", settings.embedding_model),
        )
        if not value
    ]
    if missing or not (settings.embedding_api_url and settings.embedding_api_key and settings.embedding_model):
        logger.error("EMBEDDING_PROVIDER=api is disabled, missing %s; using hash", ", ".join(missing))
        return HashEmbeddingProvider()
    return ApiEmbeddingProvider(
        settings.embedding_api_url, settings.embedding_api_key.get_secret_value(), settings.embedding_model
    )


def is_valid_matrix(matrix: object, rows: int) -> bool:
    return isinstance(matrix, np.ndarray) and matrix.shape == (rows, DIM) and bool(np.isfinite(matrix).all())

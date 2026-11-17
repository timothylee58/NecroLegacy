import asyncio
import gzip
import hashlib
import json
import logging
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Literal

from redis.asyncio import Redis

from app.core.config import _int_in_range
from app.schemas.autopsy import SessionEvent

logger = logging.getLogger("necro.cache")

KEY_PREFIX = "necro:result:"
FORMAT_VERSION = 1
REDIS_TIMEOUT_SECONDS = 2
TTL_MIN, TTL_MAX, TTL_DEFAULT = 60, 604_800, 86_400


class CacheDecodeError(ValueError):
    pass


@dataclass(frozen=True)
class CachedResult:
    input_kind: Literal["text", "image"]
    events: list[SessionEvent]


def resolve_ttl(value: Any) -> int:
    return _int_in_range("CACHE_TTL_SECONDS", value, TTL_MIN, TTL_MAX, TTL_DEFAULT)


def _frame(blob: bytes) -> bytes:
    return len(blob).to_bytes(8, "big") + blob


def cache_key(data: bytes, copybook: bytes | None = None) -> str:
    # Raw bytes are hashed before any decode so equal uploads always share a key.
    digest = hashlib.sha256(data if copybook is None else _frame(data) + _frame(copybook)).hexdigest()
    return f"{KEY_PREFIX}{digest}"


def encode(input_kind: str, events: Sequence[SessionEvent]) -> bytes:
    body = {"v": FORMAT_VERSION, "input_kind": input_kind, "events": [e.model_dump(mode="json") for e in events]}
    return gzip.compress(json.dumps(body, separators=(",", ":")).encode(), mtime=0)


def decode(blob: bytes) -> CachedResult:
    try:
        body = json.loads(gzip.decompress(blob))
        if body["v"] != FORMAT_VERSION or body["input_kind"] not in ("text", "image"):
            raise CacheDecodeError("unsupported cache entry")
        events = [SessionEvent.model_validate(e) for e in body["events"]]
    except CacheDecodeError:
        raise
    except Exception:
        raise CacheDecodeError("unreadable cache entry") from None
    return CachedResult(input_kind=body["input_kind"], events=events)


def _completed(events: Sequence[SessionEvent]) -> bool:
    last = events[-1] if events else None
    return last is not None and last.type == "terminal" and last.payload.get("status") == "completed"


class ResultCache:
    def __init__(self, redis: Redis, ttl_seconds: int = TTL_DEFAULT) -> None:
        self._redis = redis
        self.ttl = resolve_ttl(ttl_seconds)

    @classmethod
    def from_url(cls, url: str, ttl_seconds: Any = TTL_DEFAULT) -> "ResultCache":
        client = Redis.from_url(url, socket_timeout=REDIS_TIMEOUT_SECONDS, socket_connect_timeout=REDIS_TIMEOUT_SECONDS)
        return cls(client, resolve_ttl(ttl_seconds))

    async def get(self, key: str) -> CachedResult | None:
        try:
            async with asyncio.timeout(REDIS_TIMEOUT_SECONDS):
                blob = await self._redis.get(key)
            return None if blob is None else decode(blob.encode() if isinstance(blob, str) else blob)
        except Exception:
            # The key and payload are left out of the log on purpose.
            logger.warning("cache unavailable")
            return None

    async def set(self, key: str, input_kind: str, events: Sequence[SessionEvent]) -> bool:
        if not _completed(events):
            return False
        try:
            blob = encode(input_kind, events)
            async with asyncio.timeout(REDIS_TIMEOUT_SECONDS):
                await self._redis.set(key, blob, ex=self.ttl)
            return True
        except Exception:
            logger.warning("cache write failed")
            return False

    async def close(self) -> None:
        try:
            await self._redis.aclose()
        except Exception:
            logger.warning("cache close failed")

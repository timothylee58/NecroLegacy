import math
import time
from collections import deque
from collections.abc import Callable

from fastapi import Request

from app.core.errors import ApiError

# Buckets live in process memory: the API runs as a single replica because live sessions do too.
MAX_TRACKED_KEYS = 50_000


class SlidingWindowLimiter:
    def __init__(self, limit: int, window_seconds: float, clock: Callable[[], float] = time.monotonic) -> None:
        self.limit = limit
        self.window = window_seconds
        self._clock = clock
        self._hits: dict[str, deque[float]] = {}

    def check(self, key: str) -> float | None:
        """Records a hit and returns None, or returns the seconds to wait without recording one."""
        now = self._clock()
        hits = self._hits.get(key)
        if hits is None:
            if len(self._hits) >= MAX_TRACKED_KEYS:
                self._evict(now)
            hits = self._hits.setdefault(key, deque())
        while hits and hits[0] <= now - self.window:
            hits.popleft()
        if len(hits) >= self.limit:
            return hits[0] + self.window - now
        hits.append(now)
        return None

    def _evict(self, now: float) -> None:
        stale = [k for k, h in self._hits.items() if not h or h[-1] <= now - self.window]
        for k in stale:
            del self._hits[k]
        if len(self._hits) >= MAX_TRACKED_KEYS:
            # Every tracked key is active; dropping the oldest keeps memory bounded at the cost of leniency.
            oldest = min(self._hits, key=lambda k: self._hits[k][-1])
            del self._hits[oldest]


def client_key(request: Request, trusted_header: str | None) -> str:
    # Only a header the hosting edge overwrites on every request is safe; Railway does this for X-Real-IP.
    # Without one configured, every caller behind the proxy shares the proxy's bucket, which fails closed.
    if trusted_header:
        value = request.headers.get(trusted_header, "").strip()
        if value:
            return value
    return request.client.host if request.client else "unknown"


class RateLimits:
    def __init__(self, sessions_per_hour: int, searches_per_minute: int, trusted_header: str | None) -> None:
        self.sessions = SlidingWindowLimiter(sessions_per_hour, 3600)
        self.searches = SlidingWindowLimiter(searches_per_minute, 60)
        self.trusted_header = trusted_header

    def enforce(self, limiter: SlidingWindowLimiter, request: Request) -> None:
        wait = limiter.check(client_key(request, self.trusted_header))
        if wait is not None:
            raise ApiError(
                429,
                "rate_limited",
                f"Too many requests. Try again in {max(1, math.ceil(wait))} seconds.",
                headers={"Retry-After": str(max(1, math.ceil(wait)))},
            )

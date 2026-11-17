import asyncio
from dataclasses import dataclass, field

from app.agents.runtime import Timeouts, WorkerPool
from app.core.config import Settings
from app.core.llm import LLMRouter
from app.core.ratelimit import RateLimits
from app.services.cache import ResultCache
from app.services.embeddings import EmbeddingProvider
from app.services.sessions import SessionStore
from app.services.vector_store import VectorStore

MAX_WAITING_SESSIONS = 10


@dataclass
class AppContext:
    settings: Settings
    sessions: SessionStore
    router: LLMRouter
    pool: WorkerPool
    embedding_provider: EmbeddingProvider
    cache: ResultCache | None = None
    vector_store: VectorStore | None = None
    timeouts: Timeouts = field(default_factory=Timeouts)
    semaphore: asyncio.Semaphore = field(default=None)  # type: ignore[assignment]
    limits: RateLimits = field(default=None)  # type: ignore[assignment]
    waiting: int = 0
    keepalive_seconds: float = 15.0

    def __post_init__(self) -> None:
        if self.semaphore is None:
            self.semaphore = asyncio.Semaphore(self.settings.max_concurrent_sessions)
        if self.limits is None:
            self.limits = RateLimits(
                self.settings.rate_limit_sessions_per_hour,
                self.settings.rate_limit_searches_per_minute,
                self.settings.client_ip_header,
            )

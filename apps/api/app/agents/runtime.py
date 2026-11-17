import asyncio
import concurrent.futures
import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal

from app.agents.nodes.base import PoolTimeout
from app.core.config import Settings
from app.core.llm import FallbackReason, LLMRouter
from app.services.embeddings import EmbeddingProvider
from app.services.sessions import EventLog
from app.services.vector_store import VectorStore

logger = logging.getLogger("necro.pipeline")


class WorkerPool:
    """CPU-bound OpenCV and scikit-learn work runs in processes so a stuck worker can be killed.

    `inline=True` runs work on a thread instead (tests, and platforms where spawning is too slow);
    an inline timeout cannot stop the thread, it only stops waiting for it.
    """

    def __init__(self, workers: int = 2, *, inline: bool = False) -> None:
        self._workers = workers
        self._inline = inline
        self._executor: concurrent.futures.Executor | None = None

    def _ensure(self) -> concurrent.futures.Executor:
        if self._executor is None:
            if self._inline:
                self._executor = concurrent.futures.ThreadPoolExecutor(self._workers)
            else:
                self._executor = concurrent.futures.ProcessPoolExecutor(self._workers)
        return self._executor

    async def run(self, fn: Callable[..., Any], *args: Any, timeout: float) -> Any:
        loop = asyncio.get_running_loop()
        future = loop.run_in_executor(self._ensure(), fn, *args)
        try:
            return await asyncio.wait_for(future, timeout)
        except TimeoutError:
            self.recycle()
            raise PoolTimeout() from None

    def recycle(self) -> None:
        executor, self._executor = self._executor, None
        if executor is None:
            return
        if isinstance(executor, concurrent.futures.ProcessPoolExecutor):
            # shutdown() alone waits for running tasks; the stuck worker has to be terminated.
            for process in list(getattr(executor, "_processes", {}).values()):
                process.terminate()
        executor.shutdown(wait=False, cancel_futures=True)

    def close(self) -> None:
        if self._executor is not None:
            self._executor.shutdown(wait=False, cancel_futures=True)
            self._executor = None


@dataclass(frozen=True)
class Timeouts:
    vision_local: float = 45.0
    vision_node: float = 120.0
    archaeologist: float = 60.0
    ml: float = 30.0
    rot_deterministic: float = 30.0
    rot_semantic: float = 60.0
    indexing: float = 120.0
    generation: float = 30.0
    session: float = 600.0


@dataclass
class Deps:
    bus: EventLog
    router: LLMRouter
    settings: Settings
    pool: WorkerPool
    embedding_provider: EmbeddingProvider
    vector_store: VectorStore | None = None
    timeouts: Timeouts = field(default_factory=Timeouts)


class BusEventSink:
    """Bridges LLM router fallback notifications onto the session's SSE log."""

    def __init__(self, bus: EventLog) -> None:
        self._bus = bus

    async def emit_fallback(self, failed_provider: Literal["primary"], reason: FallbackReason) -> None:
        await self._bus.append("fallback", {"failed_provider": failed_provider, "reason": reason})

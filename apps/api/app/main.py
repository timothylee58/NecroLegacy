import asyncio
import hmac
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware

from app.agents.runtime import WorkerPool
from app.core.config import Settings, load_settings
from app.core.context import AppContext
from app.core.errors import error_response, install_error_handlers
from app.core.llm import LLMRouter
from app.core.logging import configure_logging
from app.routes import health, presets, search, sessions
from app.services.cache import ResultCache
from app.services.embeddings import get_provider
from app.services.sessions import SessionStore
from app.services.vector_store import PgBackend, VectorStore

logger = logging.getLogger("necro.app")


def _bearer_ok(header: str, token: str) -> bool:
    scheme, _, value = header.partition(" ")
    return scheme.lower() == "bearer" and hmac.compare_digest(value.encode(), token.encode())


async def _build_context(settings: Settings) -> AppContext:
    backend = PgBackend(settings.supabase_db_url.get_secret_value())
    store = VectorStore(backend)
    try:
        await backend.open()
        await store.ensure_schema()
    except Exception:
        # Indexing then fails per session with `store_unreachable`; the rest of the API still works.
        logger.error("vector store unavailable at startup")
    return AppContext(
        settings=settings,
        sessions=SessionStore(),
        router=LLMRouter(settings),
        pool=WorkerPool(),
        embedding_provider=get_provider(settings),
        cache=ResultCache.from_url(settings.redis_url.get_secret_value(), settings.cache_ttl_seconds),
        vector_store=store,
    )


def create_app(settings: Settings | None = None, ctx: AppContext | None = None) -> FastAPI:
    """`ctx` lets tests inject fakes; production builds it in the lifespan."""
    resolved = settings or (ctx.settings if ctx else load_settings())
    secrets = [
        v.get_secret_value()
        for v in (
            resolved.redis_url,
            resolved.supabase_db_url,
            resolved.llm_api_key,
            resolved.embedding_api_key,
            resolved.api_token,
        )
        if v is not None
    ]
    configure_logging(resolved.log_level, secrets)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        active = ctx or await _build_context(resolved)
        app.state.ctx = active
        purge: asyncio.Task[None] | None = None
        if active.vector_store is not None and ctx is None:
            purge = asyncio.create_task(active.vector_store.purge_loop(resolved.cache_ttl_seconds))
        try:
            yield
        finally:
            if purge is not None:
                purge.cancel()
                with suppress(asyncio.CancelledError):
                    await purge
            active.pool.close()
            if ctx is None:
                if active.cache is not None:
                    await active.cache.close()
                if active.vector_store is not None:
                    await active.vector_store.close()

    app = FastAPI(title="NecroLegacy API", version="0.1.0", lifespan=lifespan)
    install_error_handlers(app)

    api_token = resolved.api_token

    if api_token is not None:

        @app.middleware("http")
        async def _auth(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
            header = request.headers.get("authorization")
            if (
                header is not None
                and request.method != "OPTIONS"
                and not _bearer_ok(header, api_token.get_secret_value())
            ):
                return error_response(401, "unauthorized", "Invalid credentials.")
            return await call_next(request)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=[resolved.web_origin],
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type", "Last-Event-ID", "Authorization"],
        expose_headers=["X-Necro-Cache"],
    )
    for module in (sessions, search, presets, health):
        app.include_router(module.router)
    return app

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from typing import Annotated, Literal

from fastapi import APIRouter, File, Query, Request, UploadFile
from fastapi.responses import StreamingResponse

from app.agents.graph import run_pipeline
from app.agents.runtime import Deps
from app.agents.state import RawInput
from app.core.context import MAX_WAITING_SESSIONS, AppContext
from app.core.errors import ApiError
from app.schemas.autopsy import (
    AnomaliesResponse,
    CreateSessionResponse,
    FieldError,
    PresetRequest,
    SessionEvent,
    SessionSnapshot,
    Severity,
)
from app.services import file_checks
from app.services.cache import cache_key, degraded_causes
from app.services.presets import get_preset, read_preset
from app.services.sessions import Session

logger = logging.getLogger("necro.sessions")
router = APIRouter(prefix="/api")

KeepaliveFrame = b": keepalive\n\n"


def _ctx(request: Request) -> AppContext:
    ctx: AppContext = request.app.state.ctx
    return ctx


def _frame(event: SessionEvent) -> bytes:
    data = json.dumps(event.model_dump(mode="json"), separators=(",", ":"))
    return f"id: {event.id}\nevent: {event.type}\ndata: {data}\n\n".encode()


async def _execute(ctx: AppContext, session: Session, raw: RawInput, cache_id: str) -> None:
    ctx.waiting += 1
    acquired = False
    try:
        await ctx.semaphore.acquire()
        acquired = True
    finally:
        ctx.waiting -= 1
    try:
        deps = Deps(
            bus=session.log,
            router=ctx.router,
            settings=ctx.settings,
            pool=ctx.pool,
            embedding_provider=ctx.embedding_provider,
            vector_store=ctx.vector_store,
            timeouts=ctx.timeouts,
        )
        try:
            await run_pipeline(
                session_id=session.id, input_kind=session.input_kind, raw=raw, deps=deps, index_key=session.index_key
            )
        except Exception:
            logger.exception("session task crashed")
            if not session.log.closed:
                await session.log.append("terminal", {"status": "failed"})
        events = session.log.events()
        snapshot = session.snapshot()
        session.indexed = snapshot.resurrection is not None and snapshot.resurrection.indexing.status == "indexed"
        if ctx.cache is not None:
            # ResultCache.set itself refuses runs that did not complete.
            causes = session.log.degraded | degraded_causes(events, snapshot)
            if causes:
                logger.info("result not cached; transient failures: %s", ",".join(sorted(causes)))
            else:
                await ctx.cache.set(cache_id, session.input_kind, events)
    finally:
        if acquired:
            ctx.semaphore.release()
        ctx.sessions.mark_finished(session)


async def _start(ctx: AppContext, kind: Literal["text", "image"], raw: RawInput, digest: str) -> CreateSessionResponse:
    key = cache_key(raw.data, raw.copybook)
    cached = await ctx.cache.get(key) if ctx.cache is not None else None
    if cached is not None:
        session = ctx.sessions.create(
            cached.input_kind,
            index_key=digest,
            content_hash=digest,
            preloaded=cached.events,
            served_from_cache=True,
        )
        snapshot = session.snapshot()
        session.indexed = snapshot.resurrection is not None and snapshot.resurrection.indexing.status == "indexed"
        session.embedding_provider = ctx.embedding_provider.name
        return CreateSessionResponse(session_id=session.id, input_kind=cached.input_kind, cached=True)
    if ctx.waiting >= MAX_WAITING_SESSIONS:
        raise ApiError(503, "busy", "The service is busy. Try again shortly.")
    session = ctx.sessions.create(kind, index_key=digest, content_hash=digest)
    session.embedding_provider = ctx.embedding_provider.name
    session.task = asyncio.create_task(_execute(ctx, session, raw, key))
    return CreateSessionResponse(session_id=session.id, input_kind=kind, cached=False)


def _digest(raw: RawInput) -> str:
    return cache_key(raw.data, raw.copybook).rsplit(":", 1)[-1]


async def _read_upload(upload: UploadFile) -> bytes:
    return await file_checks.read_bounded(file_checks.iter_chunks(upload.read))


def _reject(exc: file_checks.UploadRejection) -> ApiError:
    return ApiError(exc.status, exc.code, exc.message)


@router.post("/sessions", status_code=201)
async def create_session(
    request: Request,
    file: Annotated[UploadFile, File()],
    copybook: Annotated[UploadFile | None, File()] = None,
) -> CreateSessionResponse:
    ctx = _ctx(request)
    ctx.limits.enforce(ctx.limits.sessions, request)
    try:
        data = await _read_upload(file)
        name = file.filename or ""
        kind = file_checks.validate_upload(name, len(data), data[:16])
        book: bytes | None = None
        if copybook is not None and copybook.filename:
            if kind != "text" or not copybook.filename.lower().endswith(".cpy"):
                raise ApiError(
                    422,
                    "validation_error",
                    "Request validation failed",
                    [FieldError(field="copybook", message="copybook must be a .cpy file sent with a text data file")],
                )
            book = await _read_upload(copybook)
            file_checks.validate_upload(copybook.filename, len(book), book[:16])
    except file_checks.UploadRejection as exc:
        raise _reject(exc) from None
    raw = RawInput(data=data, filename=name, copybook=book)
    return await _start(ctx, kind, raw, _digest(raw))


@router.post("/sessions/preset", status_code=201)
async def create_preset_session(request: Request, body: PresetRequest) -> CreateSessionResponse:
    limits = _ctx(request).limits
    limits.enforce(limits.sessions, request)
    preset = get_preset(body.preset_id)
    if preset is None:
        raise ApiError(404, "not_found", "Preset not found.")
    raw = RawInput(data=read_preset(preset), filename=preset.filename)
    return await _start(_ctx(request), preset.kind, raw, _digest(raw))


def get_session(request: Request, session_id: str) -> Session:
    session = _ctx(request).sessions.get(session_id)
    if session is None:
        raise ApiError(404, "session_not_found", "Session not found.")
    return session


def _last_event_id(request: Request, query_value: str | None, last_id: int) -> int:
    raw = request.headers.get("last-event-id", query_value)
    if raw is None:
        return 0
    try:
        value = int(raw.strip())
    except ValueError:
        value = -1
    if not 0 <= value <= last_id:
        raise ApiError(400, "invalid_last_event_id", "Last-Event-ID must be an integer from 0 to the last event id.")
    return value


@router.get("/sessions/{session_id}/events")
async def stream_events(
    request: Request, session_id: str, last_event_id: Annotated[str | None, Query()] = None
) -> StreamingResponse:
    ctx = _ctx(request)
    session = get_session(request, session_id)
    after = _last_event_id(request, last_event_id, session.log.last_id)

    async def frames() -> AsyncIterator[bytes]:
        events = session.log.subscribe(after).__aiter__()
        pending: asyncio.Task[SessionEvent] | None = None
        try:
            while True:
                if pending is None:
                    pending = asyncio.ensure_future(events.__anext__())
                done, _ = await asyncio.wait({pending}, timeout=ctx.keepalive_seconds)
                if not done:
                    yield KeepaliveFrame
                    continue
                task, pending = pending, None
                try:
                    event = task.result()
                except StopAsyncIteration:
                    return
                yield _frame(event)
                if event.type == "terminal":
                    return
        finally:
            if pending is not None:
                pending.cancel()
            await events.aclose()  # type: ignore[attr-defined]

    headers = {
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
        "X-Necro-Cache": "HIT" if session.served_from_cache else "MISS",
    }
    return StreamingResponse(frames(), media_type="text/event-stream", headers=headers)


@router.get("/sessions/{session_id}")
async def get_snapshot(request: Request, session_id: str) -> SessionSnapshot:
    return get_session(request, session_id).snapshot()


@router.get("/sessions/{session_id}/anomalies")
async def get_anomalies(
    request: Request,
    session_id: str,
    severity: Severity | None = None,
    entity: Annotated[str | None, Query(max_length=200)] = None,
) -> AnomaliesResponse:
    snapshot = get_session(request, session_id).snapshot()
    anomalies = snapshot.rot.anomalies if snapshot.rot else []
    return AnomaliesResponse(
        anomalies=[
            a
            for a in anomalies
            if (severity is None or a.severity == severity) and (entity is None or a.entity == entity)
        ]
    )


__all__ = ["router", "get_session"]

import asyncio

from fastapi import APIRouter, Request

from app.core.errors import ApiError
from app.routes.sessions import _ctx, get_session
from app.schemas.autopsy import FieldError, SearchResponse
from app.services.vector_store import InvalidQueryError, SearchUnavailableError, provider_for_session

router = APIRouter(prefix="/api")

SEARCH_DEADLINE_SECONDS = 5.0


async def _query(request: Request) -> str:
    try:
        body = await request.json()
    except ValueError:
        body = None
    query = body.get("query") if isinstance(body, dict) else None
    if not isinstance(query, str):
        raise ApiError(
            422,
            "validation_error",
            "Request validation failed",
            [FieldError(field="query", message="query is required")],
        )
    return query


@router.post("/sessions/{session_id}/search")
async def search(request: Request, session_id: str) -> SearchResponse:
    ctx = _ctx(request)
    session = get_session(request, session_id)
    query = await _query(request)
    if len(query) > 500 or not query.strip():
        raise ApiError(422, "invalid_query", "The query must be 1 to 500 characters.")
    if not session.indexed or ctx.vector_store is None:
        raise ApiError(409, "not_indexed", "This session has no search index.")
    snapshot = session.snapshot()
    fields = sorted(
        {f.name for e in (snapshot.schema_result.entities if snapshot.schema_result else []) for f in e.fields}
    )
    try:
        active = ctx.embedding_provider
        provider = (
            active
            if active.name == session.embedding_provider
            else provider_for_session(ctx.settings, session.embedding_provider)
        )
        async with asyncio.timeout(SEARCH_DEADLINE_SECONDS):
            hits = await ctx.vector_store.search(session.index_key, query, provider, fields)
    except InvalidQueryError:
        raise ApiError(422, "invalid_query", "The query must be 1 to 500 characters.") from None
    except (SearchUnavailableError, TimeoutError):
        raise ApiError(503, "search_unavailable", "Search is temporarily unavailable.") from None
    return SearchResponse(hits=hits)

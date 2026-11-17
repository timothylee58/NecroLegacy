import asyncio
import logging
from collections import defaultdict

from app.agents.nodes.base import Completed, NodeError
from app.agents.nodes.ml_rot_scorer import to_ml_entities
from app.agents.runtime import Deps
from app.agents.state import AutopsyState
from app.schemas.autopsy import IndexingStatus, ResurrectionResult
from app.services import codegen
from app.services.vector_store import IndexingError, build_records

logger = logging.getLogger("necro.resurrector")


async def _index(state: AutopsyState, deps: Deps) -> IndexingStatus:
    schema, dataset = state.get("schema"), state.get("dataset") or {}
    if schema is None:
        return IndexingStatus(status="failed", record_count=0, reason="no_schema")
    rot = state.get("rot")
    flags: dict[tuple[str, int], list[str]] = defaultdict(list)
    for a in rot.anomalies if rot else []:
        for row in a.affected_rows:
            if a.name not in flags[(a.entity, row)]:
                flags[(a.entity, row)].append(a.name)
    records = build_records(to_ml_entities(dataset, schema), flags)
    if deps.vector_store is None:
        return IndexingStatus(status="failed", record_count=0, reason="store_unavailable")
    try:
        count = await deps.vector_store.index_session(
            state.get("index_key") or state["session_id"],
            records,
            state.get("embeddings") or {},
            deps.embedding_provider,
            deadline_seconds=deps.timeouts.indexing,
        )
    except IndexingError as exc:
        return IndexingStatus(status="failed", record_count=0, reason=exc.reason)
    except Exception:
        logger.exception("vector store indexing failed")
        return IndexingStatus(status="failed", record_count=0, reason="store_unreachable")
    return IndexingStatus(status="indexed", record_count=count)


async def run(state: AutopsyState, deps: Deps) -> Completed:
    indexing = await _index(state, deps)
    schema, rot = state.get("schema"), state.get("rot")
    entities = schema.entities if schema else []
    try:
        async with asyncio.timeout(deps.timeouts.generation):
            generated = await asyncio.to_thread(codegen.generate, entities, rot.anomalies if rot else [])
    except TimeoutError:
        raise NodeError("generation_timeout", "Code generation exceeded its time limit.") from None
    result = ResurrectionResult(
        source=generated.source,
        syntax_ok=generated.syntax_ok,
        syntax_error=generated.syntax_error,
        indexing=indexing,
        models=generated.models,
    )
    if generated.syntax_error is not None:
        err = generated.syntax_error
        # The source stays in state so the session snapshot can still show it next to the error.
        raise NodeError(
            "syntax_error",
            f"Generated code failed the syntax check at line {err.line}: {err.message}",
            updates={"resurrection": result},
        )
    return Completed(result, {"resurrection": result})

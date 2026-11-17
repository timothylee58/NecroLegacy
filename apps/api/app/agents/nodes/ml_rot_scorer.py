import logging
from collections import Counter
from typing import Any, Protocol

from app.agents.nodes.base import Completed, PoolTimeout, Skipped
from app.agents.state import AutopsyState, Dataset
from app.core.config import Settings
from app.schemas.autopsy import MlResult, SchemaResult
from app.services.embeddings import get_provider
from app.services.ml import MlEntity, MlOutcome, score_entities

logger = logging.getLogger("necro.ml")


class _MlTimeouts(Protocol):
    @property
    def ml(self) -> float: ...


class _MlDeps(Protocol):
    """Structural stand-in for `Deps`: importing runtime would give this node a path to core.llm (6.17)."""

    @property
    def settings(self) -> Settings: ...

    @property
    def timeouts(self) -> _MlTimeouts: ...

    @property
    def pool(self) -> Any: ...


def to_ml_entities(dataset: Dataset, schema: SchemaResult) -> list[MlEntity]:
    out = []
    for entity in schema.entities:
        data = dataset.get(entity.name)
        if data is None:
            continue
        out.append(
            MlEntity(
                name=entity.name,
                fields=tuple((f.name, f.type) for f in entity.fields),
                rows=tuple(tuple(r) for r in data.rows),
                row_numbers=tuple(data.row_numbers),
            )
        )
    return out


def score_worker(entities: list[MlEntity], settings: Settings) -> MlOutcome:
    """Runs inside the process pool; the provider is rebuilt there because HTTP clients do not pickle."""
    return score_entities(entities, get_provider(settings))


async def run(state: AutopsyState, deps: _MlDeps) -> Completed | Skipped:
    dataset = state.get("dataset") or {}
    schema = state.get("schema")
    entities = to_ml_entities(dataset, schema) if schema is not None else []
    if not entities:
        return Skipped("insufficient_rows", {"ml": None, "embeddings": None})
    try:
        outcome: MlOutcome = await deps.pool.run(score_worker, entities, deps.settings, timeout=deps.timeouts.ml)
    except PoolTimeout:
        return Skipped("timeout", {"ml": None, "embeddings": None})
    except Exception:
        logger.exception("isolation forest scoring failed")
        return Skipped("scoring_error", {"ml": None, "embeddings": None})

    if outcome.coordinate_source == "numeric":
        logger.warning("embedding coordinates unavailable (%s); using numeric PCA", outcome.embedding_fallback_reason)
    embeddings = outcome.embeddings or None
    if len(outcome.skipped) == len(entities):
        reasons = Counter(s.reason for s in outcome.skipped)
        reason = next(iter(reasons)) if len(reasons) == 1 else "all_entities_skipped"
        return Skipped(reason, {"ml": None, "embeddings": embeddings})
    result = MlResult(
        anomalies=outcome.anomalies,
        skipped_entities=outcome.skipped,
        points=outcome.points,
        coordinate_source=outcome.coordinate_source,
        embedding_fallback_reason=outcome.embedding_fallback_reason,
    )
    return Completed(result, {"ml": result, "embeddings": embeddings})

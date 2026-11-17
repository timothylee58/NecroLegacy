import asyncio
from collections.abc import Callable, Sequence
from typing import Any

from pydantic import BaseModel

from app.agents.runtime import Deps, Timeouts, WorkerPool
from app.agents.state import Dataset, EntityData
from app.core.config import Settings
from app.core.llm import LLMRequest, LLMResult, ProviderFailure
from app.schemas.autopsy import Entity, FieldRole, FieldType, ForeignKey, PrimaryKey, SchemaField, SchemaResult
from app.services.embeddings import EmbeddingProvider, HashEmbeddingProvider
from app.services.sessions import EventLog
from app.services.vector_store import VectorStore


def settings(**overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "web_origin": "http://localhost:3000",
        "redis_url": "redis://x",
        "supabase_db_url": "postgresql://x",
        "aws_region": None,
    }
    values.update(overrides)
    return Settings(**values)


class NoRouter:
    def has_provider(self) -> bool:
        return False

    async def complete(self, req: LLMRequest[Any], events: Any = None) -> LLMResult[Any]:
        raise ProviderFailure([])


class StubRouter:
    """Answers every request with `answer(request)` validated against the request's response model."""

    def __init__(self, answer: Callable[[LLMRequest[Any]], dict[str, Any]]) -> None:
        self.answer = answer
        self.requests: list[LLMRequest[Any]] = []

    def has_provider(self) -> bool:
        return True

    async def complete(self, req: LLMRequest[Any], events: Any = None) -> LLMResult[Any]:
        self.requests.append(req)
        data: BaseModel = req.response_model.model_validate(self.answer(req))
        return LLMResult(data, "primary")


def make_deps(
    *,
    router: Any = None,
    store: VectorStore | None = None,
    provider: EmbeddingProvider | None = None,
    timeouts: Timeouts | None = None,
    bus: EventLog | None = None,
    **setting_overrides: Any,
) -> Deps:
    return Deps(
        bus=bus or EventLog(),
        router=router or NoRouter(),
        settings=settings(**setting_overrides),
        pool=WorkerPool(inline=True),
        embedding_provider=provider or HashEmbeddingProvider(),
        vector_store=store,
        timeouts=timeouts or Timeouts(),
    )


FieldSpec = tuple[str, FieldType, FieldRole]


def table(
    name: str,
    fields: Sequence[FieldSpec],
    rows: Sequence[Sequence[str]],
    *,
    pk: str | None = None,
    fks: Sequence[tuple[str, str, str]] = (),
    position_unit: str = "column",
    first_row: int = 2,
    byte_lengths: Sequence[int] | None = None,
    expected_length: int | None = None,
) -> tuple[Entity, EntityData]:
    schema_fields = [
        SchemaField(name=n, type=t, type_confidence=1.0, start=i + 1, end=i + 1, length=8, role=r)
        for i, (n, t, r) in enumerate(fields)
    ]
    entity = Entity(
        name=name,
        position_unit=position_unit,  # type: ignore[arg-type]
        fields=schema_fields,
        primary_key=PrimaryKey(field=pk, confidence=1.0 if pk else 0.0),
        foreign_keys=[ForeignKey(source_field=s, target_entity=t, target_field=f, confidence=0.95) for s, t, f in fks],
        row_count=len(rows),
        record_length=expected_length,
    )
    numbers = list(range(first_row, first_row + len(rows)))
    data = EntityData(
        name=name,
        fields=[n for n, _, _ in fields],
        rows=[list(r) for r in rows],
        row_numbers=numbers,
        byte_lengths=list(byte_lengths) if byte_lengths is not None else [0] * len(rows),
        expected_length=expected_length,
    )
    return entity, data


def schema_and_dataset(*tables: tuple[Entity, EntityData], copybook: bool = False) -> tuple[SchemaResult, Dataset]:
    return SchemaResult(entities=[e for e, _ in tables], copybook_used=copybook), {d.name: d for _, d in tables}


def run(coro: Any) -> Any:
    return asyncio.run(coro)

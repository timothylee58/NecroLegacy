import asyncio
import logging
import re
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, NamedTuple, Protocol

import numpy as np

from app.core.config import Settings
from app.schemas.autopsy import SearchHit
from app.services.embeddings import (
    API_BATCH,
    EmbeddingError,
    EmbeddingProvider,
    HashEmbeddingProvider,
    get_provider,
    is_valid_matrix,
    record_text,
)

logger = logging.getLogger("necro.vector_store")

INDEX_DEADLINE_SECONDS = 120.0
UPSERT_BATCH = 1_000
SEARCH_LIMIT = 100
SEARCH_MIN_SIMILARITY = 0.35
SEARCH_TIMEOUT_SECONDS = 4.5
STATEMENT_TIMEOUT_MS = 4_000
PURGE_INTERVAL_SECONDS = 3_600
QUERY_MAX_CHARS = 500

_MISSING_INTENT = re.compile(r"\b(missing|empty|blank|null|without)\b\s+(.{1,40})", re.IGNORECASE)
_WORD = re.compile(r"[a-z0-9]+")

SCHEMA_STATEMENTS = (
    "CREATE EXTENSION IF NOT EXISTS vector",
    """CREATE TABLE IF NOT EXISTS record_embeddings (
  session_key   text        NOT NULL,
  entity        text        NOT NULL,
  row_number    integer     NOT NULL,
  content       text        NOT NULL,
  empty_fields  text[]      NOT NULL DEFAULT '{}',
  anomaly_flags text[]      NOT NULL DEFAULT '{}',
  embedding     vector(384) NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_key, entity, row_number)
)""",
    "CREATE INDEX IF NOT EXISTS record_embeddings_session_idx ON record_embeddings (session_key)",
    "ALTER TABLE record_embeddings ENABLE ROW LEVEL SECURITY",
)
UPSERT_SQL = """INSERT INTO record_embeddings
  (session_key, entity, row_number, content, empty_fields, anomaly_flags, embedding)
VALUES (%s, %s, %s, %s, %s, %s, %s)
ON CONFLICT (session_key, entity, row_number) DO UPDATE SET
  content = EXCLUDED.content, empty_fields = EXCLUDED.empty_fields,
  anomaly_flags = EXCLUDED.anomaly_flags, embedding = EXCLUDED.embedding, created_at = now()"""
SEARCH_SQL = """SELECT entity, row_number, anomaly_flags, content, 1 - (embedding <=> %(q)s) AS sim
FROM record_embeddings
WHERE session_key = %(key)s AND empty_fields @> %(fields)s::text[]
ORDER BY embedding <=> %(q)s
LIMIT %(limit)s"""
PURGE_SQL = "DELETE FROM record_embeddings WHERE created_at < now() - make_interval(secs => %s)"


class IndexingError(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class SearchUnavailableError(Exception):
    pass


class InvalidQueryError(ValueError):
    pass


class Row(NamedTuple):
    session_key: str
    entity: str
    row_number: int
    content: str
    empty_fields: list[str]
    anomaly_flags: list[str]
    embedding: np.ndarray


class Match(NamedTuple):
    entity: str
    row_number: int
    anomaly_flags: list[str]
    content: str
    similarity: float


class Backend(Protocol):
    async def ensure_schema(self) -> None: ...
    async def upsert(self, rows: Sequence[Row]) -> None: ...
    async def search(self, session_key: str, vector: np.ndarray, required_empty: Sequence[str]) -> list[Match]: ...
    async def purge(self, older_than_seconds: int) -> None: ...
    async def close(self) -> None: ...


@dataclass(frozen=True)
class IndexRecord:
    entity: str
    row_number: int
    fields: tuple[str, ...]
    values: tuple[str, ...]
    anomaly_flags: tuple[str, ...] = ()
    # Position of this record's vector inside embeddings[entity], when ml_rot_scorer produced one.
    position: int | None = None


def build_records(
    entities: Sequence[Any], anomaly_rows: Mapping[tuple[str, int], Sequence[str]] | None = None
) -> list[IndexRecord]:
    """`entities` are `ml.MlEntity`; the Any avoids a second import path to the same dataclass."""
    flags = anomaly_rows or {}
    records: list[IndexRecord] = []
    for e in entities:
        names = tuple(n for n, _ in e.fields)
        for i, row in enumerate(e.rows):
            values = tuple(row[j] if j < len(row) else "" for j in range(len(names)))
            records.append(
                IndexRecord(
                    entity=e.name,
                    row_number=e.row_numbers[i],
                    fields=names,
                    values=values,
                    anomaly_flags=tuple(flags.get((e.name, e.row_numbers[i]), ())),
                    position=i,
                )
            )
    return records


def _singular(token: str) -> str:
    if len(token) > 3 and token.endswith("s") and not token.endswith(("ss", "us", "is")):
        return token[:-1]
    return token


def _tokens(text: str) -> set[str]:
    return {_singular(t) for t in _WORD.findall(text.lower())}


def analyze_query(query: str, fields: Sequence[str]) -> list[str]:
    """Fields named by a missing-value phrase; they become a hard `empty_fields` filter."""
    match = _MISSING_INTENT.search(query)
    if match is None:
        return []
    phrase = _tokens(match.group(2))
    matched: list[str] = []
    for name in fields:
        name_tokens = _tokens(name.replace("_", " "))
        if name_tokens and name_tokens <= phrase and name not in matched:
            matched.append(name)
    return matched


def _vector_for(provider_name: str, settings: Settings) -> EmbeddingProvider:
    if provider_name == "hash":
        return HashEmbeddingProvider()
    provider = get_provider(settings)
    if provider.name != provider_name:
        raise SearchUnavailableError("embedding provider changed since indexing")
    return provider


def provider_for_session(settings: Settings, recorded_name: str) -> EmbeddingProvider:
    return _vector_for(recorded_name, settings)


class VectorStore:
    def __init__(self, backend: Backend) -> None:
        self._backend = backend

    async def ensure_schema(self) -> None:
        await self._backend.ensure_schema()

    async def index_session(
        self,
        session_key: str,
        records: Sequence[IndexRecord],
        embeddings: Mapping[str, np.ndarray],
        provider: EmbeddingProvider,
        *,
        deadline_seconds: float = INDEX_DEADLINE_SECONDS,
    ) -> int:
        deadline = time.monotonic() + deadline_seconds
        vectors: list[np.ndarray | None] = []
        for r in records:
            matrix = embeddings.get(r.entity)
            usable = r.position is not None and matrix is not None and r.position < len(matrix)
            vectors.append(matrix[r.position] if usable and matrix is not None and r.position is not None else None)
        missing = [i for i, v in enumerate(vectors) if v is None]
        try:
            for start in range(0, len(missing), API_BATCH):
                if time.monotonic() > deadline:
                    raise IndexingError("timeout")
                chunk = missing[start : start + API_BATCH]
                texts = [record_text(records[i].entity, records[i].fields, records[i].values) for i in chunk]
                matrix = await asyncio.to_thread(provider.embed, texts, deadline=deadline)
                if not is_valid_matrix(matrix, len(chunk)):
                    raise IndexingError("invalid_embedding")
                for offset, i in enumerate(chunk):
                    vectors[i] = matrix[offset]
        except EmbeddingError as exc:
            raise IndexingError(exc.reason) from None
        rows: list[Row] = []
        for r, v in zip(records, vectors, strict=True):
            if v is None:
                raise IndexingError("invalid_embedding")
            rows.append(
                Row(
                    session_key=session_key,
                    entity=r.entity,
                    row_number=r.row_number,
                    content=record_text(r.entity, r.fields, r.values),
                    empty_fields=[n for n, val in zip(r.fields, r.values, strict=False) if val.strip() == ""],
                    anomaly_flags=list(r.anomaly_flags),
                    embedding=np.asarray(v, dtype=np.float32),
                )
            )
        try:
            async with asyncio.timeout(max(0.0, deadline - time.monotonic())):
                for start in range(0, len(rows), UPSERT_BATCH):
                    await self._backend.upsert(rows[start : start + UPSERT_BATCH])
        except TimeoutError:
            raise IndexingError("timeout") from None
        except IndexingError:
            raise
        except Exception:
            raise IndexingError("store_unreachable") from None
        return len(rows)

    async def search(
        self,
        session_key: str,
        query: str,
        provider: EmbeddingProvider,
        fields: Sequence[str] = (),
    ) -> list[SearchHit]:
        stripped = query.strip()
        if len(query) > QUERY_MAX_CHARS or not stripped:
            raise InvalidQueryError("query must be 1 to 500 characters")
        required = analyze_query(stripped, fields)
        try:
            async with asyncio.timeout(SEARCH_TIMEOUT_SECONDS):
                vector = await asyncio.to_thread(
                    provider.embed, [stripped], deadline=time.monotonic() + SEARCH_TIMEOUT_SECONDS
                )
                if not is_valid_matrix(vector, 1):
                    raise SearchUnavailableError("invalid query embedding")
                matches = await self._backend.search(session_key, np.asarray(vector[0], dtype=np.float32), required)
        except (TimeoutError, EmbeddingError):
            raise SearchUnavailableError("search timed out") from None
        except SearchUnavailableError:
            raise
        except Exception:
            raise SearchUnavailableError("vector store unreachable") from None
        hits = []
        for m in matches:
            sim = min(1.0, max(0.0, float(m.similarity)))
            if sim >= SEARCH_MIN_SIMILARITY:
                hits.append((sim, m))
        hits.sort(key=lambda t: -t[0])
        return [
            SearchHit(
                entity=m.entity,
                row_number=m.row_number,
                similarity=sim,
                anomaly_flags=list(m.anomaly_flags),
                preview=m.content[:200],
            )
            for sim, m in hits[:SEARCH_LIMIT]
        ]

    async def purge_loop(self, ttl_seconds: int, interval: float = PURGE_INTERVAL_SECONDS) -> None:
        while True:
            await asyncio.sleep(interval)
            try:
                await self._backend.purge(ttl_seconds)
            except Exception:
                logger.warning("vector store purge failed")

    async def close(self) -> None:
        await self._backend.close()


class PgBackend:
    def __init__(self, dsn: str, pool: Any | None = None) -> None:
        if pool is None:
            from psycopg_pool import AsyncConnectionPool

            pool = AsyncConnectionPool(
                dsn,
                min_size=1,
                max_size=5,
                timeout=3,
                open=False,
                kwargs={"prepare_threshold": None},
                configure=self._configure,
            )
        self._pool = pool

    @staticmethod
    async def _configure(conn: Any) -> None:
        from pgvector.psycopg import register_vector_async

        await register_vector_async(conn)

    async def open(self) -> None:
        await self._pool.open()

    async def ensure_schema(self) -> None:
        async with self._pool.connection() as conn:
            for statement in SCHEMA_STATEMENTS:
                await conn.execute(statement)
            await conn.commit()

    async def upsert(self, rows: Sequence[Row]) -> None:
        params = [
            (r.session_key, r.entity, r.row_number, r.content, r.empty_fields, r.anomaly_flags, r.embedding)
            for r in rows
        ]
        async with self._pool.connection() as conn, conn.cursor() as cur:
            await cur.executemany(UPSERT_SQL, params)
            await conn.commit()

    async def search(self, session_key: str, vector: np.ndarray, required_empty: Sequence[str]) -> list[Match]:
        params = {"q": vector, "key": session_key, "fields": list(required_empty), "limit": SEARCH_LIMIT}
        async with self._pool.connection() as conn, conn.transaction():
            await conn.execute(f"SET LOCAL statement_timeout = {STATEMENT_TIMEOUT_MS}")
            cur = await conn.execute(SEARCH_SQL, params)
            rows = await cur.fetchall()
        return [Match(r[0], int(r[1]), list(r[2]), r[3], float(r[4])) for r in rows]

    async def purge(self, older_than_seconds: int) -> None:
        async with self._pool.connection() as conn:
            await conn.execute(PURGE_SQL, (older_than_seconds,))
            await conn.commit()

    async def close(self) -> None:
        await self._pool.close()


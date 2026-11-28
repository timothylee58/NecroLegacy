"""Runs the real SQL against Postgres with pgvector. CI sets NECRO_TEST_PG_URL; locally it is skipped unless set."""

import asyncio
import os
import uuid

import pytest

from app.services.embeddings import HashEmbeddingProvider
from app.services.vector_store import IndexRecord, PgBackend, VectorStore

PG_URL = os.environ.get("NECRO_TEST_PG_URL")
pytestmark = pytest.mark.skipif(not PG_URL, reason="set NECRO_TEST_PG_URL to run against a real Postgres")

FIELDS = ("sku", "branch_code", "qty")
ROWS = [
    ("SKU1", "", "-48", ("negative_stock",)),
    ("SKU2", "B07", "5", ()),
    ("SKU3", " ", "1", ()),
    ("SKU4", "B01", "2", ("orphan_foreign_key",)),
]


def _records(entity: str) -> list[IndexRecord]:
    return [IndexRecord(entity, i + 1, FIELDS, values[:3], values[3], position=None) for i, values in enumerate(ROWS)]


async def _with_store(body):
    backend = PgBackend(PG_URL or "")
    await backend.open()
    try:
        store = VectorStore(backend)
        await store.ensure_schema()
        await store.ensure_schema()  # the schema statements, including the column migration, are idempotent
        return await body(store)
    finally:
        await backend.close()


def test_keyword_search_on_real_postgres_matches_the_memory_backend():
    key, other = f"t-{uuid.uuid4()}", f"t-{uuid.uuid4()}"
    provider = HashEmbeddingProvider()

    async def body(store):
        await store.index_session(key, _records("transfers"), {}, provider)
        await store.index_session(other, _records("transfers"), {}, provider)
        missing = await store.search(key, "Show all warehouse transfers with missing branch codes", provider, FIELDS)
        negative = await store.search(key, "negative stock", provider, FIELDS)
        orphan = await store.search(key, "orphan foreign keys", provider, FIELDS)
        hostile = await store.search(key, "'; DROP TABLE record_embeddings; -- %_ \\", provider, FIELDS)
        return missing, negative, orphan, hostile

    missing, negative, orphan, hostile = asyncio.run(_with_store(body))
    assert {h.row_number for h in missing} == {1, 3}
    assert [h.row_number for h in negative] == [1]
    assert [h.row_number for h in orphan] == [4] and orphan[0].anomaly_flags == ["orphan_foreign_key"]
    assert hostile == []


def test_vector_search_sql_runs_on_real_postgres():
    key = f"t-{uuid.uuid4()}"

    class ApiLike(HashEmbeddingProvider):
        name = "api"  # forces the pgvector cosine path instead of keyword matching

    async def body(store):
        provider = ApiLike()
        await store.index_session(key, _records("transfers"), {}, provider)
        return await store.search(key, "transfers | sku=SKU2; branch_code=B07; qty=5", provider, FIELDS)

    hits = asyncio.run(_with_store(body))
    assert hits and hits[0].row_number == 2


def test_a_connection_dropped_while_pooled_is_replaced_not_handed_out():
    # Neon suspends an idle compute and closes its connections; the pool must not hand one of them to the next request.
    import psycopg

    key = f"t-{uuid.uuid4()}"
    provider = HashEmbeddingProvider()

    async def body(store):
        await store.index_session(key, _records("transfers"), {}, provider)
        async with await psycopg.AsyncConnection.connect(PG_URL, autocommit=True) as admin:
            await admin.execute(
                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                "WHERE pid <> pg_backend_pid() AND datname = current_database() AND application_name = ''"
            )
        await asyncio.sleep(0.5)
        # Both a write and a read after the drop must succeed on a fresh connection.
        await store.index_session(f"{key}-again", _records("transfers"), {}, provider)
        return await store.search(key, "negative stock", provider, FIELDS)

    hits = asyncio.run(_with_store(body))
    assert [h.row_number for h in hits] == [1]

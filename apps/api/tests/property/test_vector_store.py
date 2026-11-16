import asyncio
from collections.abc import Sequence

import numpy as np
from hypothesis import given, settings
from hypothesis import strategies as st

from app.services.embeddings import HashEmbeddingProvider
from app.services.vector_store import (
    IndexingError,
    IndexRecord,
    InvalidQueryError,
    Match,
    PgBackend,
    Row,
    VectorStore,
    analyze_query,
)

FIELDS = ("sku", "branch_code", "qty")


class MemoryBackend:
    """Faithful stand-in: same filtering, ordering and limit semantics as the SQL in PgBackend."""

    def __init__(self) -> None:
        self.rows: dict[tuple[str, str, int], Row] = {}

    async def ensure_schema(self) -> None:
        return None

    async def upsert(self, rows: Sequence[Row]) -> None:
        for r in rows:
            self.rows[(r.session_key, r.entity, r.row_number)] = r

    async def search(self, session_key, vector, required_empty):
        found = [
            r
            for r in self.rows.values()
            if r.session_key == session_key and set(required_empty) <= set(r.empty_fields)
        ]
        found.sort(key=lambda r: -float(np.dot(r.embedding, vector)))
        return [Match(r.entity, r.row_number, r.anomaly_flags, r.content, float(np.dot(r.embedding, vector))) for r in found[:100]]

    async def purge(self, older_than_seconds):
        return None

    async def close(self) -> None:
        return None


class CountingProvider(HashEmbeddingProvider):
    def __init__(self) -> None:
        self.calls = 0

    def embed(self, texts, *, deadline):
        self.calls += len(texts)
        return super().embed(texts, deadline=deadline)


cell = st.one_of(st.just(""), st.just("  "), st.text(max_size=8))
metachar = st.sampled_from(["'; DROP TABLE record_embeddings; --", "%s %(q)s", '" OR 1=1', "missing branch codes", "\\"])
queries = st.one_of(st.text(min_size=1, max_size=40), metachar, st.just("Show all transfers with missing branch codes"))


@st.composite
def sessions(draw):
    out = {}
    for key in draw(st.lists(st.sampled_from(["s1", "s2", "s3"]), min_size=1, max_size=3, unique=True)):
        n = draw(st.integers(1, 12))
        out[key] = [tuple(draw(cell) for _ in FIELDS) for _ in range(n)]
    return out


def records_for(rows):
    return [
        IndexRecord("transfers", i + 1, FIELDS, values, ("truncated_field",) if i % 2 else (), position=None)
        for i, values in enumerate(rows)
    ]


@settings(max_examples=40, deadline=None)
@given(sessions(), queries)
def test_search_is_isolated_and_bounded(data, query):
    async def go():
        backend, provider = MemoryBackend(), HashEmbeddingProvider()
        store = VectorStore(backend)
        for key, rows in data.items():
            await store.index_session(key, records_for(rows), {}, provider)
        results = {}
        for key in data:
            try:
                results[key] = await store.search(key, query, provider, FIELDS)
            except InvalidQueryError:
                results[key] = None
        return backend, results

    backend, results = asyncio.run(go())
    required = analyze_query(query.strip(), FIELDS) if query.strip() else []
    for key, hits in results.items():
        if hits is None:
            assert not query.strip()
            continue
        assert len(hits) <= 100
        sims = [h.similarity for h in hits]
        assert sims == sorted(sims, reverse=True) and all(0.0 <= s <= 1.0 for s in sims)
        for h in hits:
            row = backend.rows[(key, h.entity, h.row_number)]
            assert row.session_key == key
            assert set(required) <= set(row.empty_fields)


def test_invalid_lengths_return_no_hits():
    async def go():
        store, provider = VectorStore(MemoryBackend()), HashEmbeddingProvider()
        for q in ("", "   ", "x" * 501):
            try:
                await store.search("s", q, provider)
            except InvalidQueryError:
                continue
            raise AssertionError("accepted")

    asyncio.run(go())


def test_missing_branch_codes_returns_only_empty_branch():
    rows = [("A1", "", "5"), ("A2", "B07", "5"), ("A3", " ", "1"), ("A4", "B01", "2")]

    async def go():
        backend, provider = MemoryBackend(), HashEmbeddingProvider()
        store = VectorStore(backend)
        await store.index_session("s", records_for(rows), {}, provider)
        return await store.search("s", "Show all warehouse transfers with missing branch codes", provider, FIELDS), backend

    hits, backend = asyncio.run(go())
    assert {h.row_number for h in hits} <= {1, 3}
    assert all("branch_code" in backend.rows[("s", h.entity, h.row_number)].empty_fields for h in hits)


def test_precomputed_vectors_make_no_embedding_calls():
    rows = [("A", "B", "1"), ("C", "", "2"), ("D", "E", "3")]
    pre = HashEmbeddingProvider().embed(["x", "y", "z"], deadline=1e18)

    async def go():
        provider, backend = CountingProvider(), MemoryBackend()
        recs = [IndexRecord("t", i + 1, FIELDS, v, (), position=i) for i, v in enumerate(rows)]
        await VectorStore(backend).index_session("s", recs, {"t": pre}, provider)
        return provider, backend

    provider, backend = asyncio.run(go())
    assert provider.calls == 0
    assert all(np.array_equal(backend.rows[("s", "t", i + 1)].embedding, pre[i]) for i in range(3))


def test_only_records_without_vectors_are_embedded_once():
    rows = [("A", "B", "1"), ("C", "", "2"), ("D", "E", "3")]
    pre = HashEmbeddingProvider().embed(["x"], deadline=1e18)

    async def go():
        provider = CountingProvider()
        recs = [IndexRecord("t", 1, FIELDS, rows[0], (), position=0)] + [
            IndexRecord("t", i + 2, FIELDS, v, (), position=None) for i, v in enumerate(rows[1:])
        ]
        await VectorStore(MemoryBackend()).index_session("s", recs, {"t": pre}, provider)
        return provider.calls

    assert asyncio.run(go()) == 2


def test_index_failure_is_reported():
    class Failing(MemoryBackend):
        async def upsert(self, rows):
            raise ConnectionError("down")

    async def go():
        await VectorStore(Failing()).index_session("s", records_for([("a", "b", "c")]), {}, HashEmbeddingProvider())

    try:
        asyncio.run(go())
    except IndexingError as exc:
        assert exc.reason == "store_unreachable"
    else:
        raise AssertionError("no error")


def test_pg_backend_uses_bound_parameters():
    seen = []

    class Cur:
        async def fetchall(self):
            return [("t", 1, ["x"], "c", 0.9)]

    class Conn:
        async def execute(self, sql, params=None):
            seen.append((sql, params))
            return Cur()

        def transaction(self):
            return self

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

    class Pool:
        def connection(self):
            return Conn()

    async def go():
        return await PgBackend("x", pool=Pool()).search("k'; DROP", np.zeros(384, dtype=np.float32), ["branch_code"])

    matches = asyncio.run(go())
    sql, params = seen[-1]
    assert "%(key)s" in sql and params["key"] == "k'; DROP" and params["limit"] == 100
    assert "DROP" not in sql and matches[0].similarity == 0.9

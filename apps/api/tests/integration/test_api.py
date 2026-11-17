import re
import time

import fakeredis
import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.agents.runtime import WorkerPool
from app.core.context import AppContext
from app.main import create_app
from app.services.cache import ResultCache
from app.services.embeddings import HashEmbeddingProvider
from app.services.sessions import SessionStore
from app.services.vector_store import VectorStore
from tests.pipeline_helpers import NoRouter, settings
from tests.property.test_vector_store import MemoryBackend

ORIGIN = "http://localhost:3000"


class FlatProvider(HashEmbeddingProvider):
    """Every text maps to one vector so similarity is 1.0 and only the missing-value filter selects records.

    The hash provider cannot score a natural-language query against `k=v` tokens, so it would return no hits.
    """

    def embed(self, texts, *, deadline):
        out = np.zeros((len(texts), self.dim), dtype=np.float32)
        out[:, 0] = 1.0
        return out


def make_ctx(redis=None, provider=None, **overrides) -> AppContext:
    cfg = settings(**overrides)
    return AppContext(
        settings=cfg,
        sessions=SessionStore(),
        router=NoRouter(),  # type: ignore[arg-type]
        pool=WorkerPool(inline=True),
        embedding_provider=provider or HashEmbeddingProvider(),
        cache=ResultCache(redis if redis is not None else fakeredis.FakeAsyncRedis(), 3600),
        vector_store=VectorStore(MemoryBackend()),
    )


@pytest.fixture
def ctx() -> AppContext:
    return make_ctx()


@pytest.fixture
def client(ctx):
    with TestClient(create_app(ctx.settings, ctx)) as c:
        yield c


def run_preset(client: TestClient, preset: str = "ledger_1994") -> tuple[str, bool]:
    res = client.post("/api/sessions/preset", json={"preset_id": preset})
    assert res.status_code == 201, res.text
    body = res.json()
    return body["session_id"], body["cached"]


def stream(client: TestClient, sid: str, last_id: str | None = None) -> tuple[list[tuple[int, str]], str]:
    headers = {"Last-Event-ID": last_id} if last_id is not None else {}
    with client.stream("GET", f"/api/sessions/{sid}/events", headers=headers) as res:
        assert res.status_code == 200
        cache_header = res.headers["x-necro-cache"]
        # Keepalive comments (": keepalive") carry no id; they appear when the pipeline runs slowly, as on CI.
        frames = [f for f in res.read().decode().split("\n\n") if f.strip() and not f.startswith(":")]
    parsed = []
    for f in frames:
        lines = dict(line.split(": ", 1) for line in f.split("\n") if ": " in line)
        parsed.append((int(lines["id"]), lines["data"]))
    return parsed, cache_header


def test_cache_hit_replays_identical_events(client):
    sid, cached = run_preset(client)
    first, header = stream(client, sid)
    assert not cached and header == "MISS"
    assert first[-1][1].count('"type":"terminal"') == 1 and '"completed"' in first[-1][1]
    sid2, cached2 = run_preset(client)
    second, header2 = stream(client, sid2)
    assert cached2 and header2 == "HIT"
    assert second == first
    assert client.get(f"/api/sessions/{sid2}").json()["served_from_cache"] is True


def test_reconnect_with_last_event_id_resumes(client):
    sid, _ = run_preset(client)
    full, _ = stream(client, sid)
    k = len(full) // 2
    rest, _ = stream(client, sid, str(k))
    assert rest == full[k:]
    query, _ = stream_query(client, sid, k)
    assert query == full[k:]


def stream_query(client, sid, k):
    with client.stream("GET", f"/api/sessions/{sid}/events?last_event_id={k}") as res:
        # Keepalive comments (": keepalive") carry no id; they appear when the pipeline runs slowly, as on CI.
        frames = [f for f in res.read().decode().split("\n\n") if f.strip() and not f.startswith(":")]
    return [(int(f.split("\n")[0].split(": ")[1]), f.split("\n")[2].split(": ", 1)[1]) for f in frames], ""


@pytest.mark.parametrize("value", ["abc", "-1", "9999", "1.5"])
def test_invalid_last_event_id_is_400(client, value):
    sid, _ = run_preset(client)
    stream(client, sid)
    res = client.get(f"/api/sessions/{sid}/events", headers={"Last-Event-ID": value})
    assert res.status_code == 400 and res.json()["error"]["code"] == "invalid_last_event_id"


def test_unknown_session_is_404(client):
    assert client.get("/api/sessions/nope").status_code == 404
    assert client.get("/api/sessions/nope/events").json()["error"]["code"] == "session_not_found"


def test_search_before_indexing_is_409(client, ctx):
    sid, _ = run_preset(client)
    res = client.post(f"/api/sessions/{sid}/search", json={"query": "branch"})
    assert res.status_code == 409 and res.json()["error"]["code"] == "not_indexed"


@pytest.mark.parametrize("query", ["", "   ", "x" * 501])
def test_invalid_query_is_422(client, query):
    sid, _ = run_preset(client)
    stream(client, sid)
    res = client.post(f"/api/sessions/{sid}/search", json={"query": query})
    assert res.status_code == 422 and res.json()["error"]["code"] == "invalid_query"


def test_missing_branch_codes_search_returns_only_empty_branch(monkeypatch):
    monkeypatch.setattr("app.agents.nodes.ml_rot_scorer.get_provider", lambda _settings: FlatProvider())
    ctx = make_ctx(provider=FlatProvider())
    with TestClient(create_app(ctx.settings, ctx)) as client:
        check_missing_branch(client)


def check_missing_branch(client):
    sid, _ = run_preset(client, "fnb_pos_corrupted")
    stream(client, sid)
    res = client.post(
        f"/api/sessions/{sid}/search", json={"query": "Show all warehouse transfers with missing branch codes"}
    )
    assert res.status_code == 200
    hits = res.json()["hits"]
    assert hits
    assert all(re.search(r"branch\w*=<empty>", h["preview"]) for h in hits)


def test_anomalies_filters(client):
    sid, _ = run_preset(client)
    stream(client, sid)
    everything = client.get(f"/api/sessions/{sid}/anomalies").json()["anomalies"]
    critical = client.get(f"/api/sessions/{sid}/anomalies?severity=critical").json()["anomalies"]
    assert everything and critical and all(a["severity"] == "critical" for a in critical)
    entity = everything[0]["entity"]
    only = client.get(f"/api/sessions/{sid}/anomalies", params={"entity": entity}).json()["anomalies"]
    assert only and {a["entity"] for a in only} == {entity}
    assert client.get(f"/api/sessions/{sid}/anomalies?severity=bogus").status_code == 422


class DownRedis:
    async def get(self, *_):
        raise ConnectionError("down")

    async def set(self, *_, **__):
        raise ConnectionError("down")

    async def aclose(self):
        return None


def test_redis_down_still_completes():
    ctx = make_ctx(DownRedis())
    with TestClient(create_app(ctx.settings, ctx)) as c:
        sid, cached = run_preset(c)
        frames, _ = stream(c, sid)
        assert not cached and '"completed"' in frames[-1][1]


def test_validation_errors_list_fields_without_side_effects(client, ctx):
    res = client.post("/api/sessions/preset", json={"preset_id": "secret-value-xyz"})
    assert res.status_code == 422
    body = res.json()["error"]
    assert body["code"] == "validation_error" and body["fields"][0]["field"] == "preset_id"
    assert "secret-value-xyz" not in res.text
    assert len(ctx.sessions) == 0
    assert client.post("/api/sessions").status_code == 422
    assert len(ctx.sessions) == 0


def test_upload_rejections_create_no_session(client, ctx):
    def post(name, data, **extra):
        return client.post("/api/sessions", files={"file": (name, data), **extra})

    assert post("a.exe", b"hello").json()["error"]["code"] == "unsupported_extension"
    assert post("a.dat", b"\x7fELF....").json()["error"]["code"] == "binary_executable"
    assert post("a.png", b"not a png").json()["error"]["code"] == "signature_mismatch"
    assert post("a.dat", b"x" * 5_242_881).status_code == 413
    assert post("a.dat", b"x", copybook=("c.dat", b"x")).status_code == 422
    assert len(ctx.sessions) == 0


def test_upload_creates_session(client):
    res = client.post("/api/sessions", files={"file": ("tiny.csv", b"a,b\n1,2\n3,4\n")})
    assert res.status_code == 201 and res.json()["input_kind"] == "text"
    frames, _ = stream(client, res.json()["session_id"])
    assert frames[0][0] == 1 and '"text_input"' in frames[0][1]


def test_cors_allows_only_web_origin(client):
    ok = client.get("/api/health", headers={"Origin": ORIGIN})
    assert ok.headers["access-control-allow-origin"] == ORIGIN
    other = client.get("/api/health", headers={"Origin": "http://evil.example"})
    assert "access-control-allow-origin" not in other.headers
    pre = client.options(
        "/api/sessions",
        headers={
            "Origin": ORIGIN,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "Last-Event-ID",
        },
    )
    assert pre.status_code == 200


def test_bearer_token_checked_when_present():
    ctx = make_ctx(api_token="s3cret")
    with TestClient(create_app(ctx.settings, ctx)) as c:
        assert c.get("/api/health").status_code == 200
        assert c.get("/api/health", headers={"Authorization": "Bearer s3cret"}).status_code == 200
        assert c.get("/api/health", headers={"Authorization": "Bearer wrong"}).status_code == 401


def test_presets_and_image(client):
    presets = client.get("/api/presets").json()["presets"]
    assert [p["id"] for p in presets] == ["ledger_1994", "fnb_pos_corrupted", "dotmatrix_manifest"]
    img = client.get("/api/presets/dotmatrix_manifest/image")
    assert img.headers["content-type"] == "image/png" and img.content.startswith(b"\x89PNG")
    assert client.get("/api/presets/ledger_1994/image").status_code == 404


def test_busy_when_queue_full(client, ctx):
    ctx.waiting = 10
    res = client.post("/api/sessions", files={"file": ("n.csv", b"a,b\n1,2\n")})
    assert res.status_code == 503 and res.json()["error"]["code"] == "busy"


def test_cached_first_byte_is_fast_for_large_payload():
    redis = fakeredis.FakeAsyncRedis()
    ctx = make_ctx(redis)
    big = b"id,value\n" + b"\n".join(b"%d,%d" % (i, i * 3) for i in range(300_000))
    assert 4_000_000 < len(big) <= 5_242_880
    with TestClient(create_app(ctx.settings, ctx)) as c:
        first = c.post("/api/sessions", files={"file": ("big.csv", big)}).json()["session_id"]
        stream(c, first)
        start = time.perf_counter()
        res = c.post("/api/sessions", files={"file": ("big.csv", big)})
        assert res.json()["cached"] is True
        with c.stream("GET", f"/api/sessions/{res.json()['session_id']}/events") as s:
            next(s.iter_bytes())
        assert time.perf_counter() - start < 0.3

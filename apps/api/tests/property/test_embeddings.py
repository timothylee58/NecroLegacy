import json
import subprocess
import sys
import time

import httpx
import numpy as np
import pytest
import respx
from hypothesis import given, settings
from hypothesis import strategies as st

from app.core.config import Settings
from app.services.embeddings import (
    DIM,
    ApiEmbeddingProvider,
    EmbeddingError,
    HashEmbeddingProvider,
    get_provider,
    record_text,
)

URL = "https://embed.test/v1/embeddings"
texts = st.lists(st.text(max_size=80), min_size=0, max_size=8)


def far() -> float:
    return time.monotonic() + 600


@settings(max_examples=40, deadline=None)
@given(texts)
def test_hash_contract(items):
    out = HashEmbeddingProvider().embed(items, deadline=far())
    assert out.shape == (len(items), DIM) and out.dtype == np.float32 and np.isfinite(out).all()
    for text, vec in zip(items, out, strict=True):
        norm = float(np.linalg.norm(vec))
        assert abs(norm - 1.0) < 1e-5 or (norm == 0.0 and not vec.any())
        if text == "":
            assert not vec.any()


def test_hash_same_in_fresh_process():
    samples = [record_text("e", ["a", "b"], ["12", "x y"]), "", "plain text"]
    code = (
        "import json,time;from app.services.embeddings import HashEmbeddingProvider as H;"
        "import sys;v=H().embed(json.loads(sys.argv[1]),deadline=time.monotonic()+60);"
        "print(json.dumps(v.tolist()))"
    )
    out = subprocess.run(
        [sys.executable, "-c", code, json.dumps(samples)],
        capture_output=True,
        text=True,
        check=True,
        env={"PYTHONHASHSEED": "random"},
    ).stdout
    here = HashEmbeddingProvider().embed(samples, deadline=far())
    assert np.array_equal(np.array(json.loads(out), dtype=np.float32), here)


def test_hash_deadline_raises_timeout():
    with pytest.raises(EmbeddingError) as exc:
        HashEmbeddingProvider().embed(["a"], deadline=time.monotonic() - 1)
    assert exc.value.reason == "provider_timeout"


def test_record_text_shape():
    text = record_text("ent", ["a", "b"], ["x" * 300, ""])
    assert text == f"ent | a={'x' * 200}; b=<empty>"


def _vec(n=DIM, fill=0.5):
    return [fill] * n


def api(client=None):
    return ApiEmbeddingProvider(URL, "key-canary", "m", client)


@respx.mock
def test_api_accepts_valid_and_normalizes():
    respx.post(URL).mock(
        return_value=httpx.Response(200, json={"data": [{"embedding": _vec()}, {"embedding": _vec(fill=2)}]})
    )
    out = api().embed(["a", "b"], deadline=far())
    assert out.shape == (2, DIM) and abs(float(np.linalg.norm(out[0])) - 1) < 1e-5


@respx.mock
def test_api_batches_of_256():
    route = respx.post(URL).mock(
        side_effect=lambda req: httpx.Response(
            200, json={"data": [{"embedding": _vec()} for _ in json.loads(req.content)["input"]]}
        )
    )
    api().embed(["t"] * 300, deadline=far())
    assert route.call_count == 2


BAD = {
    "dim": (httpx.Response(200, json={"data": [{"embedding": _vec(DIM - 1)}]}), "invalid_embedding"),
    "nan": (
        httpx.Response(200, content=b'{"data":[{"embedding":[' + b",".join([b"NaN"] * DIM) + b"]}]}"),
        "invalid_embedding",
    ),
    "inf": (
        httpx.Response(200, content=b'{"data":[{"embedding":[' + b",".join([b"Infinity"] * DIM) + b"]}]}"),
        "invalid_embedding",
    ),
    "count": (httpx.Response(200, json={"data": []}), "invalid_embedding"),
    "shape": (httpx.Response(200, json={"oops": 1}), "invalid_embedding"),
    "http": (httpx.Response(500, text="body-canary"), "provider_error"),
    "timeout": (httpx.ReadTimeout("slow"), "provider_timeout"),
}


@respx.mock
@pytest.mark.parametrize("kind", list(BAD))
def test_api_rejections(kind):
    result, reason = BAD[kind]
    respx.post(URL).mock(
        side_effect=[result] if isinstance(result, Exception) else None,
        return_value=None if isinstance(result, Exception) else result,
    )
    with pytest.raises(EmbeddingError) as exc:
        api().embed(["a"], deadline=far())
    assert exc.value.reason == reason
    assert "key-canary" not in str(exc.value) and "body-canary" not in str(exc.value)


def test_get_provider_defaults_and_disables_incomplete_api(env, caplog):
    assert isinstance(get_provider(Settings()), HashEmbeddingProvider)
    env.setenv("EMBEDDING_PROVIDER", "api")
    with caplog.at_level("ERROR"):
        provider = get_provider(Settings())
    assert isinstance(provider, HashEmbeddingProvider)
    assert "EMBEDDING_API_URL" in caplog.text and "EMBEDDING_API_KEY" in caplog.text
    env.setenv("EMBEDDING_API_URL", URL)
    env.setenv("EMBEDDING_API_KEY", "k")
    env.setenv("EMBEDDING_MODEL", "m")
    assert isinstance(get_provider(Settings()), ApiEmbeddingProvider)

import asyncio
import contextlib
import json
import logging

import httpx
import respx
from hypothesis import given, settings
from hypothesis import strategies as st
from pydantic import BaseModel

from app.core.config import Settings
from app.core.llm import LLMRequest, LLMRouter, ProviderFailure

ILMU_KEY = "ilmu-secret-canary-123"
CLAUDE_KEY = "claude-secret-canary-456"
BODY_CANARY = "response-body-canary-789"
ILMU_URL = "https://ilmu.test/v1/chat/completions"
CLAUDE_URL = "https://api.anthropic.com/v1/messages"


class Answer(BaseModel):
    value: int


OUTCOMES = ["ok", "http_error", "timeout", "invalid"]


def ilmu_response(outcome: str) -> httpx.Response | Exception:
    if outcome == "timeout":
        return httpx.ReadTimeout("slow")
    if outcome == "http_error":
        return httpx.Response(500, text=BODY_CANARY)
    text = '```json\n{"value": 1}\n```' if outcome == "ok" else BODY_CANARY
    return httpx.Response(200, json={"choices": [{"message": {"content": text}}]})


def claude_response(outcome: str) -> httpx.Response | Exception:
    if outcome == "timeout":
        return httpx.ReadTimeout("slow")
    if outcome == "http_error":
        return httpx.Response(529, text=BODY_CANARY)
    text = '{"value": 2}' if outcome == "ok" else BODY_CANARY
    return httpx.Response(200, json={"content": [{"type": "text", "text": text}]})


def make_settings(ilmu: bool = True, claude: bool = True) -> Settings:
    return Settings(
        web_origin="http://localhost:3000",
        redis_url="redis://x",
        supabase_db_url="postgresql://x",
        ilmu_api_key=ILMU_KEY if ilmu else None,
        ilmu_base_url="https://ilmu.test/v1",
        ilmu_model="ilmu-1",
        anthropic_api_key=CLAUDE_KEY if claude else None,
    )


class Sink:
    def __init__(self, log: list[str]) -> None:
        self.log = log
        self.calls: list[tuple[str, str]] = []

    async def emit_fallback(self, failed_provider, reason) -> None:
        self.calls.append((failed_provider, reason))
        self.log.append("fallback_event")


def run(settings: Settings, ilmu_outcome: str, claude_outcome: str, images: list[bytes] | None = None):
    order: list[str] = []
    sink = Sink(order)

    def ilmu_side(request: httpx.Request):
        order.append("ilmu")
        result = ilmu_response(ilmu_outcome)
        if isinstance(result, Exception):
            raise result
        return result

    def claude_side(request: httpx.Request):
        order.append("claude")
        result = claude_response(claude_outcome)
        if isinstance(result, Exception):
            raise result
        return result

    async def go():
        with respx.mock(assert_all_called=False) as mock:
            mock.post(ILMU_URL).mock(side_effect=ilmu_side)
            mock.post(CLAUDE_URL).mock(side_effect=claude_side)
            router = LLMRouter(settings)
            req = LLMRequest("test", "sys", "user", Answer, images=images or [])
            try:
                return await router.complete(req, sink), None
            except ProviderFailure as exc:
                return None, exc
            finally:
                await router.aclose()

    result, failure = asyncio.run(go())
    return result, failure, order, sink


@contextlib.contextmanager
def _capture_ctx():
    captured: list[str] = []

    class H(logging.Handler):
        def emit(self, record):
            captured.append(record.getMessage())

    handler = H(logging.DEBUG)
    root = logging.getLogger()
    old = root.level
    root.setLevel(logging.DEBUG)
    root.addHandler(handler)
    try:
        yield captured
    finally:
        root.removeHandler(handler)
        root.setLevel(old)


def _capture():
    return _capture_ctx()


# Property 17: Router ordering
@settings(max_examples=60, deadline=None)
@given(ilmu=st.sampled_from(OUTCOMES), claude=st.sampled_from(OUTCOMES), with_image=st.booleans())
def test_router_ordering(ilmu, claude, with_image):
    records = _capture()
    with records as captured:
        result, failure, order, sink = run(make_settings(), ilmu, claude, [b"\x89PNG"] if with_image else None)

    assert order[0] == "ilmu"
    if ilmu == "ok":
        assert order == ["ilmu"]
        assert result is not None and result.provider == "ilmu" and result.data.value == 1
        assert sink.calls == []
    else:
        assert order == ["ilmu", "fallback_event", "claude"]
        assert sink.calls[0][0] == "ilmu"
        assert sink.calls[0][1] == {"http_error": "error", "timeout": "timeout", "invalid": "validation"}[ilmu]
        if claude == "ok":
            assert result is not None and result.provider == "claude" and result.data.value == 2
        else:
            assert failure is not None
            assert [a.provider for a in failure.attempts] == ["ilmu", "claude"]
            message = str(failure)
            assert "ilmu" in message and "claude" in message

    surfaces = [str(failure) if failure else "", json.dumps(sink.calls), "\n".join(captured)]
    for surface in surfaces:
        for secret in (ILMU_KEY, CLAUDE_KEY, BODY_CANARY):
            assert secret not in surface


def test_missing_ilmu_goes_straight_to_claude():
    result, failure, order, sink = run(make_settings(ilmu=False), "ok", "ok")
    assert order == ["claude"] and result is not None and result.provider == "claude"
    assert sink.calls == []


def test_no_provider_lists_not_configured():
    router = LLMRouter(make_settings(ilmu=False, claude=False))
    assert not router.has_provider()
    try:
        asyncio.run(router.complete(LLMRequest("t", "s", "u", Answer)))
    except ProviderFailure as exc:
        assert [(a.provider, a.reason) for a in exc.attempts] == [
            ("ilmu", "not_configured"),
            ("claude", "not_configured"),
        ]
    else:
        raise AssertionError("expected ProviderFailure")

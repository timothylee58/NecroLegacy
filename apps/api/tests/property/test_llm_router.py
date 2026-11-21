import asyncio
import contextlib
import json
import logging

import httpx
import pytest
import respx
from botocore.credentials import Credentials
from hypothesis import given, settings
from hypothesis import strategies as st
from pydantic import BaseModel

from app.core.config import Settings
from app.core.llm import LLMRequest, LLMRouter, ProviderFailure

AWS_ACCESS_KEY = "AKIACANARY0000000000"
AWS_SECRET_KEY = "aws-secret-canary-123"
API_KEY = "openai-compatible-secret-canary-456"
BODY_CANARY = "response-body-canary-789"
REGION = "us-east-1"
PRIMARY_MODEL = "openai.gpt-oss-120b-1:0"
FALLBACK_MODEL = "global.anthropic.claude-sonnet-4-5-20250929-v1:0"
COMPAT_URL = "https://llm.test/v1/chat/completions"


def bedrock_url(model: str) -> str:
    return f"https://bedrock-runtime.{REGION}.amazonaws.com/model/{model.replace(':', '%3A')}/converse"


PRIMARY_URL = bedrock_url(PRIMARY_MODEL)
FALLBACK_URL = bedrock_url(FALLBACK_MODEL)


class Answer(BaseModel):
    value: int


OUTCOMES = ["ok", "http_error", "timeout", "invalid"]
VALUES = {"primary": 1, "fallback": 2}


def converse_response(role: str, outcome: str) -> httpx.Response | Exception:
    if outcome == "timeout":
        return httpx.ReadTimeout("slow")
    if outcome == "http_error":
        return httpx.Response(429 if role == "primary" else 503, text=BODY_CANARY)
    text = f'```json\n{{"value": {VALUES[role]}}}\n```' if outcome == "ok" else BODY_CANARY
    # Reasoning models put a reasoningContent block before the answer text.
    blocks = [{"reasoningContent": {"reasoningText": {"text": BODY_CANARY}}}, {"text": text}]
    return httpx.Response(200, json={"output": {"message": {"role": "assistant", "content": blocks}}})


def chat_response(role: str, outcome: str) -> httpx.Response | Exception:
    if outcome == "timeout":
        return httpx.ReadTimeout("slow")
    if outcome == "http_error":
        return httpx.Response(500, text=BODY_CANARY)
    text = f'{{"value": {VALUES[role]}}}' if outcome == "ok" else BODY_CANARY
    return httpx.Response(200, json={"choices": [{"message": {"content": text}}]})


def make_settings(
    primary: bool = True,
    fallback: bool = True,
    provider: str = "bedrock",
    primary_vision: bool = False,
    region: str | None = REGION,
) -> Settings:
    return Settings(
        web_origin="http://localhost:3000",
        redis_url="redis://x",
        supabase_db_url="postgresql://x",
        llm_provider=provider,
        aws_region=region,
        llm_primary_model=PRIMARY_MODEL if primary else "",
        llm_primary_vision=primary_vision,
        llm_fallback_model=FALLBACK_MODEL if fallback else "",
        llm_base_url="https://llm.test/v1",
        llm_api_key=API_KEY,
    )


def aws_credentials() -> Credentials:
    return Credentials(AWS_ACCESS_KEY, AWS_SECRET_KEY)


class Sink:
    def __init__(self, log: list[str]) -> None:
        self.log = log
        self.calls: list[tuple[str, str]] = []

    async def emit_fallback(self, failed_provider, reason) -> None:
        self.calls.append((failed_provider, reason))
        self.log.append("fallback_event")


def run(
    settings: Settings,
    primary_outcome: str,
    fallback_outcome: str,
    images: list[bytes] | None = None,
    credentials: Credentials | None = None,
):
    order: list[str] = []
    requests: list[httpx.Request] = []
    sink = Sink(order)
    outcomes = {"primary": primary_outcome, "fallback": fallback_outcome}

    def side(role: str, build):
        def handler(request: httpx.Request):
            order.append(role)
            requests.append(request)
            result = build(role, outcomes[role])
            if isinstance(result, Exception):
                raise result
            return result

        return handler

    def compat_side(request: httpx.Request):
        role = "primary" if json.loads(request.content)["model"] == PRIMARY_MODEL else "fallback"
        return side(role, chat_response)(request)

    async def go():
        with respx.mock(assert_all_called=False) as mock:
            mock.post(PRIMARY_URL).mock(side_effect=side("primary", converse_response))
            mock.post(FALLBACK_URL).mock(side_effect=side("fallback", converse_response))
            mock.post(COMPAT_URL).mock(side_effect=compat_side)
            router = LLMRouter(settings, aws_credentials=credentials or aws_credentials())
            req = LLMRequest("test", "sys", "user", Answer, images=images or [])
            try:
                return await router.complete(req, sink), None
            except ProviderFailure as exc:
                return None, exc
            finally:
                await router.aclose()

    result, failure = asyncio.run(go())
    return result, failure, order, sink, requests


@contextlib.contextmanager
def _capture():
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


def _assert_no_secrets(*surfaces: str) -> None:
    for surface in surfaces:
        for secret in (AWS_SECRET_KEY, API_KEY, BODY_CANARY):
            assert secret not in surface


# Property 17: Router ordering
@settings(max_examples=80, deadline=None)
@given(
    primary=st.sampled_from(OUTCOMES),
    fallback=st.sampled_from(OUTCOMES),
    with_image=st.booleans(),
    primary_vision=st.booleans(),
    provider=st.sampled_from(["bedrock", "openai_compatible"]),
)
def test_router_ordering(primary, fallback, with_image, primary_vision, provider):
    with _capture() as captured:
        result, failure, order, sink, _ = run(
            make_settings(provider=provider, primary_vision=primary_vision),
            primary,
            fallback,
            [b"\x89PNG"] if with_image else None,
        )

    if with_image and not primary_vision:
        # Text-only primary is skipped for images without a fallback event.
        assert order == ["fallback"]
        assert sink.calls == []
        if fallback == "ok":
            assert result is not None and result.provider == "fallback" and result.data.value == 2
        else:
            assert failure is not None
            assert [(a.provider, a.reason) for a in failure.attempts][0] == ("primary", "unsupported_input")
    elif primary == "ok":
        assert order == ["primary"]
        assert result is not None and result.provider == "primary" and result.data.value == 1
        assert sink.calls == []
    else:
        assert order == ["primary", "fallback_event", "fallback"]
        assert sink.calls[0] == (
            "primary",
            {"http_error": "error", "timeout": "timeout", "invalid": "validation"}[primary],
        )
        if fallback == "ok":
            assert result is not None and result.provider == "fallback" and result.data.value == 2
        else:
            assert failure is not None
            assert [a.provider for a in failure.attempts] == ["primary", "fallback"]
            assert "primary" in str(failure) and "fallback" in str(failure)

    _assert_no_secrets(str(failure) if failure else "", json.dumps(sink.calls), "\n".join(captured))


def test_bedrock_requests_are_sigv4_signed_converse_calls():
    result, _, _, _, requests = run(make_settings(), "ok", "ok")
    assert result is not None and result.provider == "primary"
    request = requests[0]
    assert str(request.url) == PRIMARY_URL
    auth = request.headers["authorization"]
    assert auth.startswith("AWS4-HMAC-SHA256 ") and f"Credential={AWS_ACCESS_KEY}/" in auth
    assert f"/{REGION}/bedrock/aws4_request" in auth
    assert "x-amz-date" in request.headers
    _assert_no_secrets(json.dumps(dict(request.headers)))
    body = json.loads(request.content)
    assert body["messages"][0]["content"][0] == {"text": "user"}
    assert "JSON Schema" in body["system"][0]["text"]


def test_bedrock_image_payload_goes_to_vision_model_only():
    _, _, order, _, requests = run(make_settings(), "ok", "ok", images=[b"\x89PNG"])
    assert order == ["fallback"]
    content = json.loads(requests[0].content)["messages"][0]["content"]
    assert content[1]["image"]["format"] == "png" and content[1]["image"]["source"]["bytes"]


def test_missing_primary_goes_straight_to_fallback():
    result, _, order, sink, _ = run(make_settings(primary=False), "ok", "ok")
    assert order == ["fallback"] and result is not None and result.provider == "fallback"
    assert sink.calls == []


def test_no_fallback_means_no_fallback_event():
    _, failure, order, sink, _ = run(make_settings(fallback=False), "timeout", "ok")
    assert order == ["primary"] and sink.calls == []
    assert failure is not None
    assert [(a.provider, a.reason) for a in failure.attempts] == [
        ("primary", "timeout"),
        ("fallback", "not_configured"),
    ]


def test_no_provider_lists_not_configured():
    router = LLMRouter(make_settings(primary=False, fallback=False), aws_credentials=aws_credentials())
    assert not router.has_provider()
    try:
        asyncio.run(router.complete(LLMRequest("t", "s", "u", Answer)))
    except ProviderFailure as exc:
        assert [(a.provider, a.reason) for a in exc.attempts] == [
            ("primary", "not_configured"),
            ("fallback", "not_configured"),
        ]
    else:
        raise AssertionError("expected ProviderFailure")


def test_bedrock_without_region_is_not_configured():
    with _capture() as captured:
        router = LLMRouter(make_settings(region=None), aws_credentials=aws_credentials())
    assert not router.has_provider()
    assert any("AWS_REGION" in line for line in captured)


def test_strip_fences_removes_a_leading_reasoning_block():
    from app.core.llm import strip_fences

    assert strip_fences('<think>\nrows look like a ledger\n</think>\n{"value": 3}') == '{"value": 3}'
    assert strip_fences('<think>plan</think>\n```json\n{"value": 4}\n```') == '{"value": 4}'
    # A tag inside a JSON value is data, not reasoning.
    assert strip_fences('{"note": "<think>x</think>"}') == '{"note": "<think>x</think>"}'


@respx.mock
def test_openai_compatible_reasoning_reply_is_accepted():
    # Qwen on Groq in its default thinking mode prepends <think>...</think> to the JSON answer.
    reply = '<think>\nThe table has one row.\n</think>\n{"value": 7}'
    respx.post(COMPAT_URL).mock(return_value=httpx.Response(200, json={"choices": [{"message": {"content": reply}}]}))
    router = LLMRouter(make_settings(provider="openai_compatible"))
    request = LLMRequest(purpose="t", system="s", user="u", response_model=Answer)
    result = asyncio.run(router.complete(request))
    assert result.data.value == 7 and result.provider == "primary"


def _compat_router(**overrides) -> LLMRouter:
    return LLMRouter(make_settings(provider="openai_compatible").model_copy(update=overrides))


@respx.mock
def test_reasoning_effort_is_sent_per_model_only_when_set():
    route = respx.post(COMPAT_URL).mock(
        return_value=httpx.Response(200, json={"choices": [{"message": {"content": '{"value": 1}'}}]})
    )
    request = LLMRequest(purpose="t", system="s", user="u", response_model=Answer)
    asyncio.run(_compat_router().complete(request))
    assert "reasoning_effort" not in json.loads(route.calls[-1].request.content)
    asyncio.run(_compat_router(llm_primary_reasoning_effort="low").complete(request))
    assert json.loads(route.calls[-1].request.content)["reasoning_effort"] == "low"


@respx.mock
def test_fallback_effort_reaches_only_the_fallback(caplog):
    bodies: list[dict] = []

    def handler(req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content)
        bodies.append(body)
        if body["model"] == PRIMARY_MODEL:
            return httpx.Response(429, text=BODY_CANARY)
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"value": 2}'}}]})

    respx.post(COMPAT_URL).mock(side_effect=handler)
    router = _compat_router(llm_fallback_reasoning_effort="none")
    with caplog.at_level(logging.WARNING, logger="necro.llm"):
        result = asyncio.run(router.complete(LLMRequest(purpose="t", system="s", user="u", response_model=Answer)))
    assert result.provider == "fallback"
    assert "reasoning_effort" not in bodies[0] and bodies[1]["reasoning_effort"] == "none"
    assert "llm primary attempt failed: purpose=t" in caplog.text and "detail=http_429" in caplog.text
    assert BODY_CANARY not in caplog.text and API_KEY not in caplog.text


@respx.mock
def test_truncated_reply_is_logged_as_length(caplog):
    cut = {"choices": [{"message": {"content": '{"val'}, "finish_reason": "length"}]}
    respx.post(COMPAT_URL).mock(return_value=httpx.Response(200, json=cut))
    router = _compat_router(llm_fallback_model="")
    with caplog.at_level(logging.WARNING, logger="necro.llm"), pytest.raises(ProviderFailure):
        asyncio.run(router.complete(LLMRequest(purpose="t", system="s", user="u", response_model=Answer)))
    assert "reason=validation detail=finish_reason=length" in caplog.text


def test_invalid_reasoning_effort_is_rejected():
    with pytest.raises(ValueError):
        make_settings().model_copy(update={}).model_validate(
            {**make_settings().model_dump(), "llm_fallback_reasoning_effort": "max"}
        )


@respx.mock
def test_schema_mismatch_names_paths_and_types_but_not_values(caplog):
    reply = '{"value": 3.5, "secret_field": "' + BODY_CANARY + '"}'
    respx.post(COMPAT_URL).mock(return_value=httpx.Response(200, json={"choices": [{"message": {"content": reply}}]}))
    router = _compat_router(llm_fallback_model="")
    with caplog.at_level(logging.WARNING, logger="necro.llm"), pytest.raises(ProviderFailure):
        asyncio.run(router.complete(LLMRequest(purpose="t", system="s", user="u", response_model=Answer)))
    assert "schema_mismatch[value:int_from_float]" in caplog.text
    assert BODY_CANARY not in caplog.text and "3.5" not in caplog.text

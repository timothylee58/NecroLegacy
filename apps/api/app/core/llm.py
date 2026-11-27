import asyncio
import base64
import json
import logging
import re
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol
from urllib.parse import quote

import httpx
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from botocore.credentials import Credentials
from botocore.session import Session as BotocoreSession
from pydantic import BaseModel, SecretStr, ValidationError

from app.core.config import Settings

logger = logging.getLogger("necro.llm")

ProviderName = Literal["primary", "fallback"]
FallbackReason = Literal["error", "timeout", "validation"]

PROVIDER_TIMEOUT_SECONDS = 30.0
MAX_TOKENS = 4096
# One retry after a 429/503 that names a short wait. Longer waits would push the call past its node's time budget
# (the vision node allows 120 s for local OCR, one LLM attempt per role and this pause), so they fail through instead.
MAX_RETRY_WAIT_SECONDS = 10.0
RETRY_STATUSES = frozenset({429, 503})
# Groq's documented rate-limit headers; only these are logged, and only when their values look like counts or durations.
RATE_LIMIT_HEADERS = (
    "retry-after",
    "x-ratelimit-limit-tokens",
    "x-ratelimit-remaining-tokens",
    "x-ratelimit-reset-tokens",
    "x-ratelimit-limit-requests",
    "x-ratelimit-remaining-requests",
    "x-ratelimit-reset-requests",
)
_HEADER_VALUE = re.compile(r"^[0-9][0-9.hms]{0,15}$")
_ERROR_CODE = re.compile(r"^[a-z_]{1,40}$")
_LIMIT_KIND = re.compile(r"\((TPM|TPD|RPM|RPD|ITPM|OTPM|ASH|ASD)\)")
_LIMIT_NUMBER = re.compile(r"\b(Limit|Used|Requested) ([0-9]{1,12})\b")
_TRY_AGAIN = re.compile(r"try again in ([0-9][0-9.hms]{0,15})")
BEDROCK_SERVICE = "bedrock"

_FENCE = re.compile(r"^\s*```[A-Za-z0-9_-]*\s*\n(.*?)\n?```\s*$", re.DOTALL)


class EventSink(Protocol):
    async def emit_fallback(self, failed_provider: Literal["primary"], reason: FallbackReason) -> None: ...

    def note_degraded(self, cause: str) -> None: ...


@dataclass
class LLMRequest[T: BaseModel]:
    purpose: str
    system: str
    user: str
    response_model: type[T]
    images: list[bytes] = field(default_factory=list)
    # Providers such as Groq reserve max_tokens against the per-minute token budget, so callers whose replies are
    # known to be short should lower it.
    max_tokens: int = MAX_TOKENS
    timeout_seconds: float = PROVIDER_TIMEOUT_SECONDS
    # One model only, the first that is configured and can take the input. For calls too slow to fit two attempts
    # in their node's time budget; the caller keeps its own deterministic fallback.
    single_attempt: bool = False


@dataclass
class LLMResult[T: BaseModel]:
    data: T
    provider: ProviderName


@dataclass(frozen=True)
class ProviderAttempt:
    provider: ProviderName
    reason: str


class ProviderFailure(RuntimeError):
    def __init__(self, attempts: list[ProviderAttempt]) -> None:
        self.attempts = attempts
        detail = "; ".join(f"{a.provider}: {a.reason}" for a in attempts)
        super().__init__(f"All LLM providers failed ({detail})")


class _AttemptFailed(Exception):
    def __init__(self, reason: str, detail: str = "", retry_after: float | None = None) -> None:
        super().__init__(reason)
        self.reason = reason
        # A code such as "http_429" or "finish_reason=length"; never response content or credentials.
        self.detail = detail
        self.retry_after = retry_after


@dataclass(frozen=True)
class _Target:
    role: ProviderName
    model: str
    vision: bool
    reasoning_effort: str | None = None


# Reasoning models served over OpenAI-compatible APIs (Qwen on Groq in its default mode) can prepend their thinking
# to the answer. Only a leading block is removed, so a reasoning tag inside a JSON string value is left alone.
_THINK = re.compile(r"\A\s*<(think|thinking|reasoning)>.*?</\1>", re.DOTALL | re.IGNORECASE)


def strip_fences(text: str) -> str:
    text = _THINK.sub("", text, count=1)
    match = _FENCE.match(text)
    return match.group(1) if match else text.strip()


def _data_uri(png: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(png).decode("ascii")


def _schema_hint(model: type[BaseModel]) -> str:
    return "Respond with a single JSON object and nothing else, matching this JSON Schema:\n" + json.dumps(
        model.model_json_schema(), separators=(",", ":")
    )


def _resolve_aws_credentials() -> Credentials | None:
    # Standard AWS chain (env vars, shared profile, container/instance role); keys never live in Settings.
    try:
        return BotocoreSession().get_credentials()
    except Exception:
        return None


class LLMRouter:
    """Primary model first, fallback model on error, timeout or invalid JSON.

    Transport is Amazon Bedrock (Converse API, SigV4) by default, or any
    OpenAI-compatible `/chat/completions` endpoint when LLM_PROVIDER=openai_compatible.
    """

    def __init__(
        self,
        settings: Settings,
        client: httpx.AsyncClient | None = None,
        aws_credentials: Credentials | None = None,
    ) -> None:
        self._transport = settings.llm_provider
        self._client = client or httpx.AsyncClient()
        self._targets = [
            _Target(
                "primary",
                settings.llm_primary_model or "",
                settings.llm_primary_vision,
                settings.llm_primary_reasoning_effort,
            ),
            _Target(
                "fallback",
                settings.llm_fallback_model or "",
                settings.llm_fallback_vision,
                settings.llm_fallback_reasoning_effort,
            ),
        ]
        self._region = settings.aws_region or ""
        self._base_url = (settings.llm_base_url or "").rstrip("/")
        self._api_key = settings.llm_api_key
        self._aws_credentials: Credentials | None = None
        if self._transport == "bedrock":
            self._aws_credentials = aws_credentials or _resolve_aws_credentials()
        self._transport_missing = self._missing_transport()
        if self._transport_missing:
            logger.error("LLM disabled: %s is not configured", self._transport_missing)
        for t in self._targets:
            if not t.model:
                logger.error("%s LLM disabled: LLM_%s_MODEL is not configured", t.role, t.role.upper())

    def _missing_transport(self) -> str | None:
        if self._transport == "bedrock":
            if not self._region:
                return "AWS_REGION"
            if self._aws_credentials is None:
                return "AWS credentials"
            return None
        if not self._base_url:
            return "LLM_BASE_URL"
        if self._api_key is None:
            return "LLM_API_KEY"
        return None

    def _usable(self, target: _Target) -> bool:
        return self._transport_missing is None and bool(target.model)

    def has_provider(self) -> bool:
        return any(self._usable(t) for t in self._targets)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def complete[T: BaseModel](self, req: LLMRequest[T], events: EventSink | None = None) -> LLMResult[T]:
        try:
            if req.single_attempt:
                return await self._complete_single(req)
            return await self._complete_routed(req, events)
        except BaseException:
            # A provider failure, or the caller's own deadline cancelling this call. Either way the run finishes
            # without this answer, and a later run may get it, so the result must not be cached.
            if events is not None:
                events.note_degraded(f"llm:{req.purpose}")
            raise

    async def _complete_routed[T: BaseModel](self, req: LLMRequest[T], events: EventSink | None) -> LLMResult[T]:
        attempts: list[ProviderAttempt] = []
        primary, fallback = self._targets
        fallback_ready = self._usable(fallback) and (fallback.vision or not req.images)

        if not self._usable(primary):
            attempts.append(ProviderAttempt("primary", "not_configured"))
        elif req.images and not primary.vision:
            # Text-only primaries (e.g. gpt-oss) never see image requests; this is routing, not a failure event.
            attempts.append(ProviderAttempt("primary", "unsupported_input"))
        else:
            try:
                return LLMResult(await self._call(primary, req), "primary")
            except _AttemptFailed as exc:
                _log_attempt(req.purpose, primary, exc)
                attempts.append(ProviderAttempt("primary", exc.reason))
                if fallback_ready and events is not None:
                    await events.emit_fallback("primary", _fallback_reason(exc.reason))

        if not self._usable(fallback):
            attempts.append(ProviderAttempt("fallback", "not_configured"))
            raise ProviderFailure(attempts)
        if req.images and not fallback.vision:
            attempts.append(ProviderAttempt("fallback", "unsupported_input"))
            raise ProviderFailure(attempts)
        try:
            return LLMResult(await self._call(fallback, req), "fallback")
        except _AttemptFailed as exc:
            _log_attempt(req.purpose, fallback, exc)
            attempts.append(ProviderAttempt("fallback", exc.reason))
            raise ProviderFailure(attempts) from None

    async def _complete_single[T: BaseModel](self, req: LLMRequest[T]) -> LLMResult[T]:
        attempts: list[ProviderAttempt] = []
        for target in self._targets:
            if not self._usable(target):
                attempts.append(ProviderAttempt(target.role, "not_configured"))
            elif req.images and not target.vision:
                attempts.append(ProviderAttempt(target.role, "unsupported_input"))
            else:
                try:
                    return LLMResult(await self._call(target, req), target.role)
                except _AttemptFailed as exc:
                    _log_attempt(req.purpose, target, exc)
                    attempts.append(ProviderAttempt(target.role, exc.reason))
                    raise ProviderFailure(attempts) from None
        raise ProviderFailure(attempts)

    async def _call[T: BaseModel](self, target: _Target, req: LLMRequest[T]) -> T:
        try:
            return await self._call_once(target, req)
        except _AttemptFailed as exc:
            if exc.retry_after is None or exc.retry_after > MAX_RETRY_WAIT_SECONDS:
                raise
            logger.warning(
                "llm %s retrying once: purpose=%s model=%s detail=%s wait=%.1fs",
                target.role,
                req.purpose,
                target.model,
                exc.detail,
                exc.retry_after,
            )
            await asyncio.sleep(exc.retry_after)
            return await self._call_once(target, req)

    async def _call_once[T: BaseModel](self, target: _Target, req: LLMRequest[T]) -> T:
        if self._transport == "bedrock":
            return await self._call_bedrock(target, req)
        return await self._call_openai_compatible(target, req)

    async def _post(
        self, url: str, headers: dict[str, str], content: bytes, timeout: float = PROVIDER_TIMEOUT_SECONDS
    ) -> dict[str, Any]:
        # Exceptions are mapped to reason codes only so no response body or header value reaches a message.
        try:
            response = await self._client.post(url, headers=headers, content=content, timeout=timeout)
        except httpx.TimeoutException:
            raise _AttemptFailed("timeout") from None
        except httpx.HTTPError:
            raise _AttemptFailed("error") from None
        if response.status_code >= 400:
            code = response.status_code
            if code in (413, 429):
                _log_rate_limit(url, response)
            retry_after = _retry_after(response.headers) if code in RETRY_STATUSES else None
            raise _AttemptFailed("error", f"http_{code}", retry_after)
        try:
            parsed = response.json()
        except ValueError:
            raise _AttemptFailed("validation", "body_not_json") from None
        if not isinstance(parsed, dict):
            raise _AttemptFailed("validation", "body_not_object")
        return parsed

    @staticmethod
    def _parse[T: BaseModel](text: Any, model: type[T]) -> T:
        if not isinstance(text, str):
            raise _AttemptFailed("validation", "no_text")
        try:
            return model.model_validate_json(strip_fences(text))
        except ValidationError as exc:
            raise _AttemptFailed("validation", f"schema_mismatch[{_error_codes(exc)}]") from None

    def bedrock_url(self, model: str) -> str:
        # Model ids contain ':' and inference-profile prefixes; SigV4 signs the encoded path, as boto3 does.
        return f"https://bedrock-runtime.{self._region}.amazonaws.com/model/{quote(model, safe='')}/converse"

    async def _call_bedrock[T: BaseModel](self, target: _Target, req: LLMRequest[T]) -> T:
        assert self._aws_credentials is not None
        content: list[dict[str, Any]] = [{"text": req.user}]
        content += [
            {"image": {"format": "png", "source": {"bytes": base64.b64encode(img).decode("ascii")}}}
            for img in req.images
        ]
        body = json.dumps(
            {
                "system": [{"text": f"{req.system}\n\n{_schema_hint(req.response_model)}"}],
                "messages": [{"role": "user", "content": content}],
                "inferenceConfig": {"maxTokens": req.max_tokens},
            }
        ).encode()
        url = self.bedrock_url(target.model)
        aws_req = AWSRequest(method="POST", url=url, data=body, headers={"Content-Type": "application/json"})
        try:
            frozen = self._aws_credentials.get_frozen_credentials()
            SigV4Auth(frozen, BEDROCK_SERVICE, self._region).add_auth(aws_req)
        except Exception:
            raise _AttemptFailed("error") from None
        data = await self._post(url, dict(aws_req.headers.items()), body, req.timeout_seconds)
        try:
            blocks = data["output"]["message"]["content"]
            # Reasoning models emit reasoningContent blocks before the answer; take the first text block.
            text = next(b["text"] for b in blocks if isinstance(b, dict) and "text" in b)
        except (KeyError, TypeError, StopIteration):
            raise _AttemptFailed("validation", "no_text") from None
        return self._parse(text, req.response_model)

    async def _call_openai_compatible[T: BaseModel](self, target: _Target, req: LLMRequest[T]) -> T:
        assert self._api_key is not None
        content: list[dict[str, Any]] = [{"type": "text", "text": req.user}]
        content += [{"type": "image_url", "image_url": {"url": _data_uri(img)}} for img in req.images]
        payload: dict[str, Any] = {
            "model": target.model,
            "max_tokens": req.max_tokens,
            "messages": [
                {"role": "system", "content": f"{req.system}\n\n{_schema_hint(req.response_model)}"},
                {"role": "user", "content": content},
            ],
        }
        if target.reasoning_effort is not None:
            payload["reasoning_effort"] = target.reasoning_effort
        headers = {**_bearer(self._api_key), "Content-Type": "application/json"}
        data = await self._post(
            f"{self._base_url}/chat/completions", headers, json.dumps(payload).encode(), req.timeout_seconds
        )
        try:
            choice = data["choices"][0]
            text = choice["message"]["content"]
        except (KeyError, IndexError, TypeError):
            raise _AttemptFailed("validation", "no_choice") from None
        if isinstance(choice, dict) and choice.get("finish_reason") == "length":
            # The reply hit max_tokens; a cut-off JSON object cannot validate, so say why instead of "invalid".
            raise _AttemptFailed("validation", "finish_reason=length")
        return self._parse(text, req.response_model)


def _bearer(key: SecretStr) -> dict[str, str]:
    return {"Authorization": f"Bearer {key.get_secret_value()}"}


def _error_codes(exc: ValidationError, limit: int = 3) -> str:
    """Field path and error type of the first errors, e.g. `rows.0.2.bbox.y:int_from_float`.

    Pydantic's `input` (the model's actual reply) is never included. Our own validators raise fixed messages,
    so for `value_error` the message names which rule failed.
    """
    parts = []
    for err in exc.errors(include_input=False, include_url=False)[:limit]:
        loc = ".".join(str(p) for p in err["loc"]) or "root"
        kind = err["type"]
        if kind == "value_error":
            kind = str(err["msg"]).removeprefix("Value error, ")[:60].replace(" ", "_")
        parts.append(f"{loc}:{kind}")
    more = exc.error_count() - len(parts)
    return ",".join(parts) + (f",+{more}" if more > 0 else "")


def _retry_after(headers: httpx.Headers) -> float | None:
    # Seconds only; the HTTP-date form is not used by the providers we route to.
    try:
        wait = float(headers.get("retry-after", ""))
    except ValueError:
        return None
    return wait if 0 <= wait < float("inf") else None


def _limit_facts(response: httpx.Response) -> list[str]:
    """Which limit was hit, from the error body, as fixed codes and numbers only.

    The headers cover only requests a day and tokens a minute, so a 429 caused by the daily token limit (or a
    request too large for the per-minute budget) looks like a full budget there. Groq's message names the limit,
    but it also carries the organization id, so nothing is copied from it except these matched fragments.
    """
    try:
        error = response.json().get("error") or {}
    except (ValueError, AttributeError):
        return []
    if not isinstance(error, dict):
        return []
    facts = []
    code = error.get("code")
    if isinstance(code, str) and _ERROR_CODE.match(code):
        facts.append(f"code={code}")
    message = error.get("message")
    if isinstance(message, str):
        message = message[:2000]
        if kind := _LIMIT_KIND.search(message):
            facts.append(f"limit={kind.group(1)}")
        facts += [f"{m.group(1).lower()}={m.group(2)}" for m in _LIMIT_NUMBER.finditer(message)]
        if wait := _TRY_AGAIN.search(message):
            facts.append(f"try_again={wait.group(1)}")
    return facts


def _log_rate_limit(url: str, response: httpx.Response) -> None:
    host = httpx.URL(url).host
    values = []
    for name in RATE_LIMIT_HEADERS:
        value = response.headers.get(name)
        if value is not None and _HEADER_VALUE.match(value):
            values.append(f"{name.removeprefix('x-ratelimit-')}={value}")
    values += _limit_facts(response)
    logger.warning(
        "llm rate limited: host=%s status=%d %s",
        host,
        response.status_code,
        " ".join(values) or "no_rate_limit_detail",
    )


def _log_attempt(purpose: str, target: _Target, exc: _AttemptFailed) -> None:
    # Codes only: purpose and model are fixed identifiers; reason and detail never carry content or secrets.
    logger.warning(
        "llm %s attempt failed: purpose=%s model=%s reason=%s%s",
        target.role,
        purpose,
        target.model,
        exc.reason,
        f" detail={exc.detail}" if exc.detail else "",
    )


def _fallback_reason(reason: str) -> FallbackReason:
    return "timeout" if reason == "timeout" else "validation" if reason == "validation" else "error"

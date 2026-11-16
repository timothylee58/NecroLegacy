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
BEDROCK_SERVICE = "bedrock"

_FENCE = re.compile(r"^\s*```[A-Za-z0-9_-]*\s*\n(.*?)\n?```\s*$", re.DOTALL)


class EventSink(Protocol):
    async def emit_fallback(self, failed_provider: Literal["primary"], reason: FallbackReason) -> None: ...


@dataclass
class LLMRequest[T: BaseModel]:
    purpose: str
    system: str
    user: str
    response_model: type[T]
    images: list[bytes] = field(default_factory=list)


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
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class _Target:
    role: ProviderName
    model: str
    vision: bool


def strip_fences(text: str) -> str:
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
            _Target("primary", settings.llm_primary_model or "", settings.llm_primary_vision),
            _Target("fallback", settings.llm_fallback_model or "", settings.llm_fallback_vision),
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
            attempts.append(ProviderAttempt("fallback", exc.reason))
            raise ProviderFailure(attempts) from None

    async def _call[T: BaseModel](self, target: _Target, req: LLMRequest[T]) -> T:
        if self._transport == "bedrock":
            return await self._call_bedrock(target, req)
        return await self._call_openai_compatible(target, req)

    async def _post(self, url: str, headers: dict[str, str], content: bytes) -> dict[str, Any]:
        # Exceptions are mapped to reason codes only so no response body or header value reaches a message.
        try:
            response = await self._client.post(url, headers=headers, content=content, timeout=PROVIDER_TIMEOUT_SECONDS)
        except httpx.TimeoutException:
            raise _AttemptFailed("timeout") from None
        except httpx.HTTPError:
            raise _AttemptFailed("error") from None
        if response.status_code >= 400:
            raise _AttemptFailed("error")
        try:
            parsed = response.json()
        except ValueError:
            raise _AttemptFailed("validation") from None
        if not isinstance(parsed, dict):
            raise _AttemptFailed("validation")
        return parsed

    @staticmethod
    def _parse[T: BaseModel](text: Any, model: type[T]) -> T:
        if not isinstance(text, str):
            raise _AttemptFailed("validation")
        try:
            return model.model_validate_json(strip_fences(text))
        except ValidationError:
            raise _AttemptFailed("validation") from None

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
                "inferenceConfig": {"maxTokens": MAX_TOKENS},
            }
        ).encode()
        url = self.bedrock_url(target.model)
        aws_req = AWSRequest(method="POST", url=url, data=body, headers={"Content-Type": "application/json"})
        try:
            frozen = self._aws_credentials.get_frozen_credentials()
            SigV4Auth(frozen, BEDROCK_SERVICE, self._region).add_auth(aws_req)
        except Exception:
            raise _AttemptFailed("error") from None
        data = await self._post(url, dict(aws_req.headers.items()), body)
        try:
            blocks = data["output"]["message"]["content"]
            # Reasoning models emit reasoningContent blocks before the answer; take the first text block.
            text = next(b["text"] for b in blocks if isinstance(b, dict) and "text" in b)
        except (KeyError, TypeError, StopIteration):
            raise _AttemptFailed("validation") from None
        return self._parse(text, req.response_model)

    async def _call_openai_compatible[T: BaseModel](self, target: _Target, req: LLMRequest[T]) -> T:
        assert self._api_key is not None
        content: list[dict[str, Any]] = [{"type": "text", "text": req.user}]
        content += [{"type": "image_url", "image_url": {"url": _data_uri(img)}} for img in req.images]
        body = json.dumps(
            {
                "model": target.model,
                "max_tokens": MAX_TOKENS,
                "messages": [
                    {"role": "system", "content": f"{req.system}\n\n{_schema_hint(req.response_model)}"},
                    {"role": "user", "content": content},
                ],
            }
        ).encode()
        headers = {**_bearer(self._api_key), "Content-Type": "application/json"}
        data = await self._post(f"{self._base_url}/chat/completions", headers, body)
        try:
            text = data["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError):
            raise _AttemptFailed("validation") from None
        return self._parse(text, req.response_model)


def _bearer(key: SecretStr) -> dict[str, str]:
    return {"Authorization": f"Bearer {key.get_secret_value()}"}


def _fallback_reason(reason: str) -> FallbackReason:
    return "timeout" if reason == "timeout" else "validation" if reason == "validation" else "error"

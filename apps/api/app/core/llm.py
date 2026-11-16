import base64
import json
import logging
import re
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

import httpx
from pydantic import BaseModel, SecretStr, ValidationError

from app.core.config import Settings

logger = logging.getLogger("necro.llm")

ProviderName = Literal["ilmu", "claude"]
FallbackReason = Literal["error", "timeout", "validation"]

PROVIDER_TIMEOUT_SECONDS = 30.0
ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"
MAX_TOKENS = 4096

_FENCE = re.compile(r"^\s*```[A-Za-z0-9_-]*\s*\n(.*?)\n?```\s*$", re.DOTALL)


class EventSink(Protocol):
    async def emit_fallback(self, failed_provider: Literal["ilmu"], reason: FallbackReason) -> None: ...


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


def strip_fences(text: str) -> str:
    match = _FENCE.match(text)
    return match.group(1) if match else text.strip()


def _data_uri(png: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(png).decode("ascii")


def _schema_hint(model: type[BaseModel]) -> str:
    return "Respond with a single JSON object and nothing else, matching this JSON Schema:\n" + json.dumps(
        model.model_json_schema(), separators=(",", ":")
    )


class LLMRouter:
    def __init__(self, settings: Settings, client: httpx.AsyncClient | None = None) -> None:
        self._ilmu_key = settings.ilmu_api_key
        self._ilmu_base = (settings.ilmu_base_url or "").rstrip("/")
        self._ilmu_model = settings.ilmu_model or ""
        self._claude_key = settings.anthropic_api_key
        self._claude_model = settings.anthropic_model
        self._client = client or httpx.AsyncClient()
        self._ilmu_missing = self._missing_ilmu()
        if self._ilmu_missing:
            logger.error("ILMU provider disabled: %s is not configured", self._ilmu_missing)
        if self._claude_key is None:
            logger.error("Claude provider disabled: ANTHROPIC_API_KEY is not configured")

    def _missing_ilmu(self) -> str | None:
        if self._ilmu_key is None:
            return "ILMU_API_KEY"
        if not self._ilmu_base:
            return "ILMU_BASE_URL"
        if not self._ilmu_model:
            return "ILMU_MODEL"
        return None

    def has_provider(self) -> bool:
        return self._ilmu_missing is None or self._claude_key is not None

    async def aclose(self) -> None:
        await self._client.aclose()

    async def complete[T: BaseModel](self, req: LLMRequest[T], events: EventSink | None = None) -> LLMResult[T]:
        attempts: list[ProviderAttempt] = []
        if self._ilmu_missing is None:
            try:
                return LLMResult(await self._call_ilmu(req), "ilmu")
            except _AttemptFailed as exc:
                attempts.append(ProviderAttempt("ilmu", exc.reason))
                if self._claude_key is not None and events is not None:
                    await events.emit_fallback("ilmu", _fallback_reason(exc.reason))
        else:
            attempts.append(ProviderAttempt("ilmu", "not_configured"))

        if self._claude_key is None:
            attempts.append(ProviderAttempt("claude", "not_configured"))
            raise ProviderFailure(attempts)
        try:
            return LLMResult(await self._call_claude(req, self._claude_key), "claude")
        except _AttemptFailed as exc:
            attempts.append(ProviderAttempt("claude", exc.reason))
            raise ProviderFailure(attempts) from None

    async def _post(self, url: str, headers: dict[str, str], body: dict[str, Any]) -> dict[str, Any]:
        # Exceptions are mapped to reason codes only so no response body or header value reaches a message.
        try:
            response = await self._client.post(url, headers=headers, json=body, timeout=PROVIDER_TIMEOUT_SECONDS)
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

    async def _call_ilmu[T: BaseModel](self, req: LLMRequest[T]) -> T:
        assert self._ilmu_key is not None
        content: list[dict[str, Any]] = [{"type": "text", "text": req.user}]
        content += [{"type": "image_url", "image_url": {"url": _data_uri(img)}} for img in req.images]
        body = {
            "model": self._ilmu_model,
            "messages": [
                {"role": "system", "content": f"{req.system}\n\n{_schema_hint(req.response_model)}"},
                {"role": "user", "content": content},
            ],
        }
        data = await self._post(f"{self._ilmu_base}/chat/completions", _bearer(self._ilmu_key), body)
        try:
            text = data["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError):
            raise _AttemptFailed("validation") from None
        return self._parse(text, req.response_model)

    async def _call_claude[T: BaseModel](self, req: LLMRequest[T], key: SecretStr) -> T:
        content: list[dict[str, Any]] = [
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/png",
                    "data": base64.b64encode(img).decode("ascii"),
                },
            }
            for img in req.images
        ]
        content.append({"type": "text", "text": req.user})
        body = {
            "model": self._claude_model,
            "max_tokens": MAX_TOKENS,
            "system": f"{req.system}\n\n{_schema_hint(req.response_model)}",
            "messages": [{"role": "user", "content": content}],
        }
        headers = {"x-api-key": key.get_secret_value(), "anthropic-version": ANTHROPIC_VERSION}
        data = await self._post(ANTHROPIC_URL, headers, body)
        try:
            blocks = data["content"]
            text = next(b["text"] for b in blocks if b.get("type") == "text")
        except (KeyError, TypeError, StopIteration):
            raise _AttemptFailed("validation") from None
        return self._parse(text, req.response_model)


def _bearer(key: SecretStr) -> dict[str, str]:
    return {"Authorization": f"Bearer {key.get_secret_value()}"}


def _fallback_reason(reason: str) -> FallbackReason:
    return "timeout" if reason == "timeout" else "validation" if reason == "validation" else "error"

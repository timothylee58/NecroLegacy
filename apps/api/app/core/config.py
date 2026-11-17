import logging
from typing import Annotated, Any, Literal

from pydantic import Field, SecretStr, ValidationError, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

logger = logging.getLogger("necro.config")

REQUIRED_VARIABLES = ("WEB_ORIGIN", "REDIS_URL", "SUPABASE_DB_URL")


class ConfigError(RuntimeError):
    """Raised at startup; the message names variables only, never their values."""


def _int_in_range(name: str, value: Any, low: int, high: int, default: int) -> int:
    # Warning names the variable and never echoes the offending value (it may be a secret by mistake).
    try:
        parsed = int(str(value).strip())
    except (TypeError, ValueError):
        parsed = None
    if parsed is None or not low <= parsed <= high:
        logger.warning("%s is invalid (expected integer %d-%d); using default %d", name, low, high, default)
        return default
    return parsed


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=None, extra="ignore", case_sensitive=False)

    web_origin: str
    redis_url: SecretStr
    supabase_db_url: SecretStr

    # Bedrock credentials come from the standard AWS chain (env, profile, role), never from Settings.
    llm_provider: Literal["bedrock", "openai_compatible"] = "bedrock"
    aws_region: str | None = None
    llm_primary_model: str | None = "openai.gpt-oss-120b-1:0"
    llm_primary_vision: bool = False
    llm_fallback_model: str | None = "global.anthropic.claude-sonnet-4-5-20250929-v1:0"
    llm_fallback_vision: bool = True
    llm_base_url: str | None = None
    llm_api_key: SecretStr | None = None

    ocr_engine: Literal["paddleocr", "tesseract"] = "paddleocr"
    embedding_provider: Literal["hash", "api"] = "hash"
    embedding_api_url: str | None = None
    embedding_api_key: SecretStr | None = None
    embedding_model: str | None = None

    cache_ttl_seconds: Annotated[int, Field(ge=60, le=604_800)] = 86_400
    sanitizer_max_chars: Annotated[int, Field(ge=1, le=100_000)] = 10_000
    max_concurrent_sessions: Annotated[int, Field(ge=1, le=8)] = 2
    rate_limit_sessions_per_hour: Annotated[int, Field(ge=1, le=10_000)] = 30
    rate_limit_searches_per_minute: Annotated[int, Field(ge=1, le=10_000)] = 30
    client_ip_header: str | None = None
    # Rejects requests that send a wrong bearer token; requests with no Authorization header still pass,
    # because the browser never holds the token. Abuse control is the rate limit, not this.
    api_token: SecretStr | None = None
    log_level: str = "INFO"

    @field_validator("llm_api_key", "embedding_api_key", "api_token", mode="before")
    @classmethod
    def _blank_secret_is_unset(cls, v: Any) -> Any:
        return None if isinstance(v, str) and not v.strip() else v

    @field_validator("aws_region", "llm_primary_model", "llm_fallback_model", "llm_base_url", mode="before")
    @classmethod
    def _blank_is_unset(cls, v: Any) -> Any:
        return None if isinstance(v, str) and not v.strip() else v

    @field_validator("llm_provider", mode="before")
    @classmethod
    def _llm_provider(cls, v: Any) -> Any:
        if v in ("bedrock", "openai_compatible"):
            return v
        if v not in (None, ""):
            logger.warning("LLM_PROVIDER is invalid (expected bedrock or openai_compatible); using bedrock")
        return "bedrock"

    @field_validator("ocr_engine", mode="before")
    @classmethod
    def _ocr_engine(cls, v: Any) -> Any:
        if v in ("paddleocr", "tesseract"):
            return v
        if v not in (None, ""):
            logger.warning("OCR_ENGINE is invalid (expected paddleocr or tesseract); using paddleocr")
        return "paddleocr"

    @field_validator("embedding_provider", mode="before")
    @classmethod
    def _embedding_provider(cls, v: Any) -> Any:
        if v in ("hash", "api"):
            return v
        if v not in (None, ""):
            logger.warning("EMBEDDING_PROVIDER is invalid (expected hash or api); using hash")
        return "hash"

    @field_validator("cache_ttl_seconds", mode="before")
    @classmethod
    def _ttl(cls, v: Any) -> Any:
        return _int_in_range("CACHE_TTL_SECONDS", v, 60, 604_800, 86_400)

    @field_validator("sanitizer_max_chars", mode="before")
    @classmethod
    def _sanitizer(cls, v: Any) -> Any:
        return _int_in_range("SANITIZER_MAX_CHARS", v, 1, 100_000, 10_000)

    @field_validator("max_concurrent_sessions", mode="before")
    @classmethod
    def _sessions(cls, v: Any) -> Any:
        return _int_in_range("MAX_CONCURRENT_SESSIONS", v, 1, 8, 2)

    @field_validator("rate_limit_sessions_per_hour", mode="before")
    @classmethod
    def _session_rate(cls, v: Any) -> Any:
        return _int_in_range("RATE_LIMIT_SESSIONS_PER_HOUR", v, 1, 10_000, 30)

    @field_validator("rate_limit_searches_per_minute", mode="before")
    @classmethod
    def _search_rate(cls, v: Any) -> Any:
        return _int_in_range("RATE_LIMIT_SEARCHES_PER_MINUTE", v, 1, 10_000, 30)

    @field_validator("client_ip_header", mode="before")
    @classmethod
    def _ip_header(cls, v: Any) -> Any:
        return v.strip().lower() or None if isinstance(v, str) else v

    @field_validator("web_origin", mode="before")
    @classmethod
    def _origin(cls, v: Any) -> Any:
        return v.strip().rstrip("/") if isinstance(v, str) else v

    @field_validator("web_origin", "redis_url", "supabase_db_url", mode="after")
    @classmethod
    def _non_empty(cls, v: Any) -> Any:
        raw = v.get_secret_value() if isinstance(v, SecretStr) else v
        if not raw.strip():
            raise ValueError("must not be empty")
        return v


def load_settings(**overrides: Any) -> Settings:
    try:
        return Settings(**overrides)
    except ValidationError as exc:
        names = sorted({str(err["loc"][0]).upper() for err in exc.errors() if err["loc"]})
        raise ConfigError(f"Invalid or missing configuration: {', '.join(names)}") from None

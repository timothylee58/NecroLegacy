import logging

import pytest

from app.core.config import ConfigError, load_settings


@pytest.mark.parametrize(
    ("missing", "named"),
    [("WEB_ORIGIN", "WEB_ORIGIN"), ("REDIS_URL", "REDIS_URL"), ("SUPABASE_DB_URL", "DATABASE_URL")],
)
def test_missing_required_variable_is_named_without_values(env, missing, named):
    env.delenv(missing)
    with pytest.raises(ConfigError) as exc:
        load_settings()
    assert named in str(exc.value)
    assert "localhost" not in str(exc.value)


def test_database_url_is_the_preferred_name_for_postgres(env):
    env.delenv("SUPABASE_DB_URL")
    env.setenv("DATABASE_URL", "postgresql://neon@example/db")
    assert load_settings().supabase_db_url.get_secret_value() == "postgresql://neon@example/db"


def test_database_url_wins_over_the_legacy_name(env):
    env.setenv("DATABASE_URL", "postgresql://new@example/db")
    assert load_settings().supabase_db_url.get_secret_value() == "postgresql://new@example/db"


def test_defaults(env):
    s = load_settings()
    assert (s.ocr_engine, s.cache_ttl_seconds, s.sanitizer_max_chars, s.max_concurrent_sessions) == (
        "paddleocr",
        86_400,
        10_000,
        2,
    )
    assert s.llm_provider == "bedrock" and s.llm_api_key is None
    assert s.llm_primary_model == "openai.gpt-oss-120b-1:0" and not s.llm_primary_vision
    assert s.llm_fallback_model is not None and "anthropic.claude" in s.llm_fallback_model
    assert s.llm_fallback_vision


def test_invalid_ocr_engine_warns_once_and_defaults(env, caplog):
    env.setenv("OCR_ENGINE", "magic")
    with caplog.at_level(logging.WARNING, logger="necro.config"):
        s = load_settings()
    assert s.ocr_engine == "paddleocr"
    assert len([r for r in caplog.records if "OCR_ENGINE" in r.getMessage()]) == 1


@pytest.mark.parametrize("value", ["59", "604801", "abc", "-1"])
def test_ttl_out_of_range_defaults_with_warning(env, caplog, value):
    env.setenv("CACHE_TTL_SECONDS", value)
    with caplog.at_level(logging.WARNING, logger="necro.config"):
        assert load_settings().cache_ttl_seconds == 86_400
    assert any("CACHE_TTL_SECONDS" in r.getMessage() for r in caplog.records)


@pytest.mark.parametrize(("value", "expected"), [("60", 60), ("604800", 604_800)])
def test_ttl_boundaries_accepted(env, value, expected):
    env.setenv("CACHE_TTL_SECONDS", value)
    assert load_settings().cache_ttl_seconds == expected


def test_sanitizer_and_sessions_ranges(env):
    env.setenv("SANITIZER_MAX_CHARS", "100001")
    env.setenv("MAX_CONCURRENT_SESSIONS", "9")
    s = load_settings()
    assert (s.sanitizer_max_chars, s.max_concurrent_sessions) == (10_000, 2)


def test_secrets_are_not_in_repr(env):
    env.setenv("LLM_API_KEY", "super-secret-key")
    assert "super-secret-key" not in repr(load_settings())


def test_invalid_llm_provider_warns_and_defaults(env, caplog):
    env.setenv("LLM_PROVIDER", "ilmu")
    with caplog.at_level(logging.WARNING, logger="necro.config"):
        assert load_settings().llm_provider == "bedrock"
    assert any("LLM_PROVIDER" in r.getMessage() for r in caplog.records)


def test_blank_model_disables_that_model(env):
    env.setenv("LLM_PRIMARY_MODEL", "  ")
    assert load_settings().llm_primary_model is None

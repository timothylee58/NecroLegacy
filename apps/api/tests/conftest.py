import pytest

from app.core.config import Settings


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch) -> pytest.MonkeyPatch:
    for name in list(__import__("os").environ):
        if name.upper() in {f.upper() for f in Settings.model_fields}:
            monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("WEB_ORIGIN", "http://localhost:3000")
    monkeypatch.setenv("REDIS_URL", "redis://localhost:6379/0")
    monkeypatch.setenv("SUPABASE_DB_URL", "postgresql://u:p@localhost:5432/db")
    return monkeypatch

"""Writes the API's OpenAPI document, plus models that no route returns directly, as JSON."""

import json
import sys
from pathlib import Path

from app.core.config import Settings
from app.core.context import AppContext
from app.main import create_app
from app.schemas.autopsy import ErrorResponse, SessionEvent


def build() -> dict:  # type: ignore[type-arg]
    settings = Settings(web_origin="http://localhost:3000", redis_url="redis://x", supabase_db_url="postgresql://x")
    schema = create_app(settings, _unused(settings)).openapi()
    defs = schema.setdefault("components", {}).setdefault("schemas", {})
    for model in (ErrorResponse, SessionEvent):
        extra = model.model_json_schema(ref_template="#/components/schemas/{model}", mode="serialization")
        for name, body in extra.pop("$defs", {}).items():
            defs.setdefault(name, body)
        defs[model.__name__] = extra
    return schema


def _unused(settings: Settings) -> AppContext:
    from app.agents.runtime import WorkerPool
    from app.core.llm import LLMRouter
    from app.services.embeddings import HashEmbeddingProvider
    from app.services.sessions import SessionStore

    return AppContext(
        settings=settings,
        sessions=SessionStore(),
        router=LLMRouter(settings, aws_credentials=None),
        pool=WorkerPool(inline=True),
        embedding_provider=HashEmbeddingProvider(),
    )


if __name__ == "__main__":
    target = Path(sys.argv[1])
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(build(), indent=2, sort_keys=True) + "\n")

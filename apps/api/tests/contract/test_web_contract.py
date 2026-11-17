import json
from pathlib import Path

import pytest

from app.schemas.autopsy import SessionEvent, payload_model

GENERATED = Path(__file__).resolve().parents[4] / "apps" / "web" / "contract" / "generated"
MOCK_EVENTS = GENERATED / "mock-events.json"


@pytest.mark.skipif(not MOCK_EVENTS.exists(), reason="run `vitest run mock-events.dump` to export the mock events")
def test_mock_event_streams_match_pydantic_models():
    scripts = json.loads(MOCK_EVENTS.read_text())
    assert scripts
    for name, events in scripts.items():
        assert [e["id"] for e in events] == list(range(1, len(events) + 1)), name
        for raw in events:
            event = SessionEvent.model_validate({"node": None, "state": None, **raw})
            payload_model(event.type, event.node, event.state).model_validate(event.payload)
        assert events[-1]["type"] == "terminal", name


def test_openapi_exposes_every_wire_model():
    from scripts.dump_openapi import build

    names = set(build()["components"]["schemas"])
    assert {"SessionSnapshot", "SessionEvent", "SearchResponse", "CreateSessionResponse", "ErrorResponse"} <= names

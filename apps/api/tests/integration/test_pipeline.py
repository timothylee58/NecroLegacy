import json
import logging
import math
import time
from pathlib import Path
from typing import Any

import cv2
import httpx
import numpy as np
import pytest
import respx

from app.agents.graph import run_pipeline
from app.agents.nodes import ml_rot_scorer, rot_detector
from app.agents.nodes.base import PoolTimeout
from app.agents.runtime import Timeouts, WorkerPool
from app.agents.state import RawInput
from app.core.llm import LLMRouter, ProviderFailure
from app.schemas.autopsy import NODE_ORDER
from app.services import vision
from app.services.vector_store import VectorStore
from tests.ml_helpers import RaisingProvider
from tests.pipeline_helpers import NoRouter, StubRouter, make_deps, run
from tests.property.test_llm_router import AWS_SECRET_KEY, FALLBACK_URL, PRIMARY_URL, aws_credentials, make_settings
from tests.property.test_vector_store import CountingProvider, MemoryBackend
from tests.vision_helpers import StubEngine, skewed_table_png

DUMPS = Path(__file__).resolve().parents[4] / "sample-dumps"
LEDGER = DUMPS / "1994_mainframe_ledger_dump.dat"
FNB = DUMPS / "corrupted_fnb_warehouse_pos_batch.txt"


def converse(request: httpx.Request) -> httpx.Response:
    system = json.loads(request.content)["system"][0]["text"]
    answer = {"roles": []} if "label columns" in system else {"explanations": [], "findings": []}
    return httpx.Response(200, json={"output": {"message": {"content": [{"text": json.dumps(answer)}]}}})


@pytest.fixture
def bedrock():
    with respx.mock(assert_all_called=False) as mock:
        primary = mock.post(PRIMARY_URL).mock(side_effect=converse)
        mock.post(FALLBACK_URL).mock(side_effect=converse)
        yield primary


def router() -> LLMRouter:
    return LLMRouter(make_settings(), aws_credentials=aws_credentials())


def pipeline(
    path: Path | None = None, *, data: bytes | None = None, kind: str = "text", name: str = "", **deps_kw: Any
):
    deps = make_deps(**deps_kw)
    raw = RawInput(data if data is not None else path.read_bytes(), name or (path.name if path else "input.txt"))
    final = run(run_pipeline(session_id="sess", input_kind=kind, raw=raw, deps=deps))  # type: ignore[arg-type]
    return final, deps.bus.events()


def node_events(events) -> list[tuple[str | None, str | None]]:
    return [(e.node, e.state) for e in events if e.type == "node"]


def completed(events, node: str) -> dict[str, Any]:
    return next(e.payload for e in events if e.node == node and e.state == "completed")


@pytest.mark.parametrize("path", [LEDGER, FNB], ids=["ledger", "fnb"])
def test_text_presets_run_end_to_end(bedrock, path):
    store = VectorStore(MemoryBackend())
    final, events = pipeline(path, router=router(), store=store)
    assert node_events(events)[0] == ("vision_extractor", "skipped")
    assert events[0].payload == {"reason": "text_input"}
    expected = [("vision_extractor", "skipped")] + [(n, s) for n in NODE_ORDER[1:] for s in ("started", "completed")]
    assert node_events(events) == expected
    assert events[-1].type == "terminal" and events[-1].payload["status"] == "completed"
    assert [e.id for e in events] == list(range(1, len(events) + 1))
    rot = completed(events, "rot_detector")
    assert rot["semantic_checks"] == "completed" and bedrock.called
    names = {(a["name"], a["severity"]) for a in rot["anomalies"]}
    assert ("orphan_foreign_key", "critical") in names
    critical = "negative_ledger_balance" if path == LEDGER else "negative_stock"
    assert (critical, "critical") in names
    resurrection = completed(events, "api_resurrector")
    rows = sum(e["row_count"] for e in completed(events, "schema_archaeologist")["entities"])
    assert resurrection["syntax_ok"] and resurrection["indexing"] == {
        "status": "indexed",
        "record_count": rows,
        "reason": None,
    }


def test_image_session_with_skewed_table(monkeypatch, bedrock):
    stub = {"paddleocr": lambda: StubEngine("paddleocr"), "tesseract": lambda: StubEngine("tesseract")}
    monkeypatch.setattr(vision, "_default_factories", lambda: stub)
    final, events = pipeline(data=skewed_table_png(3.0), kind="image", name="manifest.png", router=router())
    vision_payload = completed(events, "vision_extractor")
    # Same tolerance as the vision unit tests: grid detection on a rotated image may add a spurious cell.
    assert vision_payload["engine"] == "paddleocr" and len(vision_payload["cells"]) >= 18
    assert {(c["row"], c["col"]) for c in vision_payload["cells"]} == {(r, c) for r in range(1, 6) for c in range(1, 5)}
    assert math.isclose(abs(vision_payload["skew_angle_degrees"]), 3.0, abs_tol=1.0)
    assert node_events(events)[:2] == [("vision_extractor", "started"), ("vision_extractor", "completed")]
    assert events[-1].payload["status"] == "completed"


def _unsure_ocr(monkeypatch):
    unsure = {"paddleocr": lambda: StubEngine("paddleocr", [0.2]), "tesseract": lambda: StubEngine("tesseract", [0.2])}
    monkeypatch.setattr(vision, "_default_factories", lambda: unsure)


def test_low_confidence_ocr_is_kept_when_no_llm_is_configured(monkeypatch):
    # The free deployment's faded dot-matrix preset takes this path whenever the vision LLM is absent or rate-limited.
    _unsure_ocr(monkeypatch)
    final, events = pipeline(data=skewed_table_png(0.0), kind="image", name="manifest.png", router=NoRouter())
    vision_payload = completed(events, "vision_extractor")
    assert len(vision_payload["cells"]) == 20 and all(c["confidence"] < 0.4 for c in vision_payload["cells"])
    assert events[-1].payload["status"] == "completed"


def test_low_confidence_ocr_is_kept_when_the_vision_llm_fails(monkeypatch):
    _unsure_ocr(monkeypatch)
    failing = StubRouter(lambda _req: (_ for _ in ()).throw(ProviderFailure([])))
    final, events = pipeline(data=skewed_table_png(0.0), kind="image", name="manifest.png", router=failing)
    assert len(completed(events, "vision_extractor")["cells"]) == 20
    assert events[-1].payload["status"] == "completed"


def test_image_without_a_table_still_fails_when_no_llm_is_configured():
    blank = cv2.imencode(".png", np.full((600, 800), 255, np.uint8))[1].tobytes()
    final, events = pipeline(data=blank, kind="image", name="blank.png", router=NoRouter())
    errors = [e for e in events if e.type == "error"]
    assert errors and errors[0].payload["code"] == "no_table_detected"
    assert events[-1].payload["status"] == "failed"


def test_failing_node_ends_with_error_then_terminal():
    _, events = pipeline(data=b"", name="empty.txt")
    assert events[-2].type == "error"
    assert events[-2].payload["node"] == "schema_archaeologist" and events[-2].payload["code"] == "no_records"
    assert events[-1].payload == {"status": "failed", "failed_node": "schema_archaeologist"}
    assert ("ml_rot_scorer", "started") not in node_events(events)


def test_rot_detector_failure_skips_resurrector(monkeypatch):
    def broken(*_: Any) -> list[Any]:
        raise RuntimeError("bug")

    monkeypatch.setattr(rot_detector, "deterministic_checks", broken)
    _, events = pipeline(FNB)
    assert ("rot_detector", "failed") in node_events(events)
    skipped = next(e for e in events if e.node == "api_resurrector")
    assert skipped.state == "skipped" and skipped.payload == {"reason": "rot_detector_failed"}
    assert events[-1].payload == {"status": "failed", "failed_node": "rot_detector"}


def test_indexing_failure_still_generates_code():
    class Failing(MemoryBackend):
        async def upsert(self, rows):
            raise ConnectionError("down")

    _, events = pipeline(FNB, store=VectorStore(Failing()))
    resurrection = completed(events, "api_resurrector")
    assert resurrection["indexing"]["status"] == "failed" and resurrection["indexing"]["reason"] == "store_unreachable"
    assert resurrection["syntax_ok"] and "FastAPI" in resurrection["source"]
    assert events[-1].payload["status"] == "completed"


def test_embedding_failure_falls_back_to_numeric_coordinates(monkeypatch):
    monkeypatch.setattr(ml_rot_scorer, "get_provider", lambda _s: RaisingProvider("provider_error"))
    _, events = pipeline(FNB)
    ml = completed(events, "ml_rot_scorer")
    assert ml["coordinate_source"] == "numeric" and ml["embedding_fallback_reason"] == "provider_error"
    assert events[-1].payload["status"] == "completed"


def test_ml_timeout_is_a_skip_not_a_failure(monkeypatch):
    def slow(*_: Any) -> None:
        time.sleep(1.0)

    monkeypatch.setattr(ml_rot_scorer, "score_worker", slow)
    _, events = pipeline(FNB, timeouts=Timeouts(ml=0.05))
    ml = next(e for e in events if e.node == "ml_rot_scorer" and e.state != "started")
    assert ml.state == "skipped" and ml.payload == {"reason": "timeout"}
    assert events[-1].payload["status"] == "completed"


def test_process_pool_timeout_recycles_the_pool():
    pool = WorkerPool(workers=1)
    try:
        with pytest.raises(PoolTimeout):
            run(pool.run(time.sleep, 30, timeout=0.5))
        assert run(pool.run(math.sqrt, 16.0, timeout=30)) == 4.0
    finally:
        pool.close()


# Property 20 (reuse half): one embedding per record across ml_rot_scorer and api_resurrector,
# and coordinates do not depend on whether the vector store is reachable.
def test_embeddings_are_reused_and_coordinates_ignore_the_store(monkeypatch):
    counter = CountingProvider()
    monkeypatch.setattr(ml_rot_scorer, "get_provider", lambda _s: counter)
    _, events = pipeline(FNB, store=VectorStore(MemoryBackend()), provider=counter)
    rows = sum(e["row_count"] for e in completed(events, "schema_archaeologist")["entities"])
    assert completed(events, "api_resurrector")["indexing"]["record_count"] == rows
    assert counter.calls == rows

    class Unreachable(MemoryBackend):
        async def upsert(self, rows):
            raise OSError("unreachable")

    _, offline = pipeline(FNB, store=VectorStore(Unreachable()), provider=counter)
    assert completed(offline, "ml_rot_scorer")["points"] == completed(events, "ml_rot_scorer")["points"]


# Property 18 extended over a full run: canaries in file content and credentials never reach a log record.
def test_full_run_logs_contain_no_canaries(bedrock):
    canary = "CANARY-9b1d"
    data = (
        FNB.read_bytes()
        .replace(b"Rice 5kg", f"{canary} Rice".encode())
        .replace(b"SKU1003|N001|-48", f"SKU1003|N001|-48{canary}".encode())
    )
    captured: list[str] = []

    class Capture(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            captured.append(record.getMessage() + " " + json.dumps(record.__dict__, default=str))

    root = logging.getLogger()
    handler, old = Capture(logging.DEBUG), root.level
    root.addHandler(handler)
    root.setLevel(logging.DEBUG)
    try:
        _, events = pipeline(data=data, name="fnb.txt", router=router())
    finally:
        root.removeHandler(handler)
        root.setLevel(old)
    assert events[-1].type == "terminal" and captured
    assert all(canary not in line and AWS_SECRET_KEY not in line for line in captured)

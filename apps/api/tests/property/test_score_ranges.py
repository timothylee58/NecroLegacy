import math
from typing import Any

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st
from pydantic import ValidationError

from app.agents.graph import run_pipeline
from app.agents.state import RawInput
from app.schemas.autopsy import Anomaly, BoundingBox, MlResult, SearchHit, SpatialPoint, VisionCell
from app.services import vision
from app.services.embeddings import HashEmbeddingProvider
from app.services.ml import score_entities
from tests.ml_helpers import RaisingProvider, far_deadline, make_entity
from tests.pipeline_helpers import make_deps, run
from tests.vision_helpers import StubEngine, skewed_table_png

SCORE_KEYS = {"confidence", "type_confidence", "encoding_confidence", "similarity"}


def walk(value: Any, found: list[tuple[str, Any]], key: str = "") -> None:
    if isinstance(value, dict):
        is_point = "outlier_score" in value
        for k, v in value.items():
            if k in {"x", "y", "z"}:
                if is_point:
                    found.append((k, v))
                continue
            walk(v, found, str(k))
    elif isinstance(value, list):
        for v in value:
            walk(v, found, key)
    elif key in SCORE_KEYS:
        found.append((key, value))


def assert_ranges(payloads: list[dict[str, Any]]) -> None:
    found: list[tuple[str, Any]] = []
    for p in payloads:
        walk(p, found)
    for key, v in found:
        assert isinstance(v, int | float) and math.isfinite(v)
        if key in {"x", "y", "z"}:
            assert -1.0 <= v <= 1.0
        else:
            assert 0.0 <= v <= 1.0 and round(v, 2) == v


cell = st.one_of(
    st.integers(min_value=-500, max_value=500).map(str),
    st.floats(min_value=-1e4, max_value=1e4, allow_nan=False).map(lambda f: f"{f:.2f}"),
    st.sampled_from(["", "N001", "S002", "alpha beta", "2024-01-31"]),
)


@st.composite
def csv_files(draw: Any) -> bytes:
    cols = draw(st.integers(min_value=2, max_value=5))
    rows = draw(st.lists(st.lists(cell, min_size=cols, max_size=cols), min_size=1, max_size=40))
    header = ",".join(f"col_{i}" for i in range(cols))
    return ("\n".join([header, *(",".join(r) for r in rows)]) + "\n").encode()


# Property 6: Score ranges
@settings(max_examples=25, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(data=csv_files())
def test_pipeline_scores_stay_in_range(data):
    deps = make_deps()
    run(run_pipeline(session_id="s", input_kind="text", raw=RawInput(data, "gen.csv"), deps=deps))
    events = deps.bus.events()
    assert events[-1].type == "terminal"
    assert_ranges([e.payload for e in events])


@settings(max_examples=15, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(confidences=st.lists(st.floats(min_value=0.0, max_value=1.0, allow_nan=False), min_size=1, max_size=6))
def test_vision_scores_stay_in_range(confidences):
    engine = StubEngine("tesseract", confidences, text="7.5")
    result = vision.analyze(skewed_table_png(2.0), "tesseract", {"tesseract": engine})
    assert_ranges(
        [{"cells": [c.model_dump() for c in result.cells], "defects": [d.model_dump() for d in result.defects]}]
    )


@pytest.mark.parametrize("provider", [HashEmbeddingProvider(), RaisingProvider("provider_error")])
def test_coordinates_in_range_for_both_sources(provider):
    outcome = score_entities([make_entity(n=60, seed=3)], provider, far_deadline())
    assert outcome.coordinate_source == ("embedding" if isinstance(provider, HashEmbeddingProvider) else "numeric")
    assert_ranges([{"points": [p.model_dump() for p in outcome.points]}])
    with_fields = MlResult(
        anomalies=outcome.anomalies,
        skipped_entities=outcome.skipped,
        points=outcome.points,
        coordinate_source=outcome.coordinate_source,
        embedding_fallback_reason=outcome.embedding_fallback_reason,
    )
    without = MlResult.model_validate(
        with_fields.model_dump(exclude={"coordinate_source", "embedding_fallback_reason"})
    )
    assert without.coordinate_source == "embedding" and without.embedding_fallback_reason is None


@pytest.mark.parametrize(
    ("build", "bad"),
    [
        (lambda v: SearchHit(entity="e", row_number=1, similarity=v, anomaly_flags=[], preview=""), 1.01),
        (
            lambda v: VisionCell(
                row=1, col=1, text="", bbox=BoundingBox(x=0, y=0, width=1, height=1), confidence=v, smudged=False
            ),
            -0.01,
        ),
        (lambda v: SpatialPoint(entity="e", row_number=1, x=v, y=0, z=0, flagged=False, outlier_score=0), 1.5),
        (
            lambda v: Anomaly(
                id="a",
                name="statistical_outlier",
                entity="e",
                field=None,
                affected_rows=[1],
                affected_row_count=1,
                sample_rows=[],
                severity="low",
                confidence=v,
                root_cause="r",
                source="ml",
            ),
            2.0,
        ),
    ],
)
def test_models_reject_out_of_range(build, bad):
    with pytest.raises(ValidationError):
        build(bad)

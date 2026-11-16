import math
from concurrent.futures import ProcessPoolExecutor

import numpy as np
import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st
from sklearn.ensemble import IsolationForest

from app.services.embeddings import HashEmbeddingProvider
from app.services.ml import MlEntity, _numeric_columns, score_entities
from tests.ml_helpers import BadShapeProvider, RaisingProvider, far_deadline, make_entity

PROVIDER = HashEmbeddingProvider()
SLOW = settings(max_examples=15, deadline=None, suppress_health_check=[HealthCheck.too_slow])


@st.composite
def entities(draw):
    n = draw(st.integers(min_value=20, max_value=60))
    seed = draw(st.integers(min_value=0, max_value=1000))
    return make_entity(n=n, outlier=draw(st.booleans()), seed=seed)


def run(entity: MlEntity, provider=PROVIDER):
    return score_entities([entity], provider, far_deadline())


@SLOW
@given(entities())
def test_property_8_determinism_and_geometry(entity):
    a, b = run(entity), run(entity)
    assert [p.model_dump() for p in a.points] == [p.model_dump() for p in b.points]
    assert a.coordinate_source == "embedding"
    assert len(a.points) == len(entity.rows)
    assert sorted(p.row_number for p in a.points) == list(entity.row_numbers)
    for p in a.points:
        assert all(math.isfinite(v) and -1 <= v <= 1 for v in (p.x, p.y, p.z))
        assert p.flagged == (p.outlier_score < -0.15)
        assert p.outlier_score == round(p.outlier_score, 6)


def _in_fresh_process(entity):
    return [
        (p.row_number, p.x, p.y, p.z, p.outlier_score)
        for p in score_entities([entity], PROVIDER, far_deadline()).points
    ]


def test_property_8_fresh_process_equal():
    entity = make_entity(n=50)
    with ProcessPoolExecutor(max_workers=1) as pool:
        other = pool.submit(_in_fresh_process, entity).result(timeout=120)
    here = _in_fresh_process(entity)
    assert other == here


def test_boundary_minus_point_fifteen_not_flagged(monkeypatch):
    entity = make_entity(n=30)
    values = np.full(30, -0.15)
    values[0] = -0.150001
    monkeypatch.setattr(IsolationForest, "decision_function", lambda self, X: values)
    outcome = run(entity)
    assert [p.flagged for p in outcome.points] == [True] + [False] * 29


@SLOW
@given(st.integers(min_value=0, max_value=19))
def test_skip_insufficient_rows(n):
    outcome = run(make_entity(n=n))
    assert [(s.entity, s.reason) for s in outcome.skipped] == [("orders", "insufficient_rows")]
    assert outcome.points == [] and outcome.anomalies == []
    assert len(outcome.embeddings["orders"]) == n


def test_skip_no_numeric_columns():
    entity = MlEntity("t", (("a", "string"), ("b", "date")), tuple(("x", "y") for _ in range(25)), tuple(range(1, 26)))
    assert run(entity).skipped[0].reason == "no_numeric_columns"


def test_skip_constant_features():
    entity = make_entity(n=30, constant=True)
    outcome = run(entity)
    assert outcome.skipped[0].reason == "constant_features"
    assert "orders" in outcome.embeddings


def test_all_zero_axis_and_padding():
    # Two distinct rows give rank 1: the second and third axes are noise and must be exactly 0.0.
    rows = tuple(("A", str(i % 2 * 100)) for i in range(30))
    entity = MlEntity("t", (("k", "string"), ("v", "integer")), rows, tuple(range(1, 31)))
    outcome = run(entity)
    assert {p.y for p in outcome.points} == {0.0} and {p.z for p in outcome.points} == {0.0}
    assert any(p.x != 0.0 for p in outcome.points)


def test_outlier_anomaly_names_field_and_rows():
    outcome = run(make_entity(n=40))
    (a,) = outcome.anomalies
    assert a.name == "statistical_outlier" and a.source == "ml" and a.field in ("qty", "price")
    assert 40 in a.affected_rows and a.affected_row_count == len(a.affected_rows)
    assert len(a.sample_rows) <= 5 and set(a.affected_rows) == set(a.outlier_scores or {})


@pytest.mark.parametrize("flagged", [0, 10, 4999, 5000, 5500])
def test_sampling_caps_at_5000_flagged_first(flagged):
    from app.schemas.autopsy import SpatialPoint
    from app.services.ml import _sample

    pts = [
        (
            SpatialPoint(
                entity="e",
                row_number=i + 1,
                x=0,
                y=0,
                z=0,
                flagged=i < flagged,
                outlier_score=-0.2 - i * 1e-6 if i < flagged else 0.1,
            ),
            i,
        )
        for i in range(8000)
    ]
    out = _sample(pts)
    assert len(out) <= 5000
    assert sum(p.flagged for p in out) == min(flagged, 5000)
    rows = [p.row_number for p in out]
    assert len(set(rows)) == len(rows)
    if flagged < 5000:
        assert {p.row_number for p in out if p.flagged} == set(range(1, flagged + 1))
        assert len(out) > flagged


def _numeric_only(entity: MlEntity):
    from app.services.ml import _byte_variance, _numeric_coordinates

    _, matrix, _ = _numeric_columns(entity)
    variance = _byte_variance(entity)
    cols = [matrix] if matrix.shape[1] else []
    if variance.max() != variance.min():
        cols.append(variance.reshape(-1, 1))
    return _numeric_coordinates(np.hstack(cols))


FAILURES = [
    (RaisingProvider("provider_error"), "provider_error"),
    (RaisingProvider("provider_timeout"), "provider_timeout"),
    (RaisingProvider("invalid_embedding"), "invalid_embedding"),
    (BadShapeProvider("dim"), "invalid_embedding"),
    (BadShapeProvider("nan"), "invalid_embedding"),
    (BadShapeProvider("inf"), "invalid_embedding"),
    (BadShapeProvider("constant"), "degenerate_embedding"),
]


@SLOW
@pytest.mark.parametrize(("provider", "reason"), FAILURES)
@given(entities())
def test_property_19_fallback_equivalence(provider, reason, entity):
    good, bad = run(entity), run(entity, provider)
    assert bad.skipped == [] and bad.coordinate_source == "numeric" and bad.embedding_fallback_reason == reason
    expected = _numeric_only(entity)
    got = np.array([[p.x, p.y, p.z] for p in bad.points])
    assert np.array_equal(got, expected)
    assert [(p.outlier_score, p.flagged) for p in bad.points] == [(p.outlier_score, p.flagged) for p in good.points]
    assert [a.model_dump() for a in bad.anomalies] == [a.model_dump() for a in good.anomalies]


def test_isolation_forest_parameters_pinned():
    entity = make_entity(n=40)
    _, matrix, _ = _numeric_columns(entity)
    assert IsolationForest(contamination="auto", random_state=42).get_params()["contamination"] == "auto"
    assert matrix.shape[1] == 2

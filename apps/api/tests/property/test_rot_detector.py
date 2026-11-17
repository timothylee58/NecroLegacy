from typing import Any

from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from app.agents.nodes import rot_detector
from app.agents.nodes.rot_detector import ALWAYS_CRITICAL, classify_outlier, deterministic_checks
from app.schemas.autopsy import Anomaly, MlResult, SpatialPoint
from app.services.ml import score_entities
from tests.ml_helpers import make_entity
from tests.pipeline_helpers import StubRouter, make_deps, run, schema_and_dataset, table

PARENT_FIELDS = [("pid", "string", "identifier"), ("label", "string", "other")]
CHILD_FIELDS = [
    ("cid", "string", "identifier"),
    ("pid", "string", "identifier"),
    ("qty", "integer", "quantity_stock"),
    ("bal", "decimal", "balance"),
    ("amount", "decimal", "amount"),
]
RECORD_LENGTH = 40


def build(n: int, *, orphan: bool, negative_stock: bool, negative_balance: bool, overflow: bool, duplicate: bool):
    parents = [[f"P{i:03d}", f"Parent {i}"] for i in range(5)]
    rows = [[f"C{i:04d}", f"P{i % 5:03d}", str(10 + i), f"{100 + i}.00", f"{5 + i}.50"] for i in range(n)]
    lengths = [RECORD_LENGTH] * n
    if orphan:
        rows[0][1] = "P999"
    if negative_stock:
        rows[1][2] = "-4"
    if negative_balance:
        rows[2][3] = "-12.00"
    if overflow:
        lengths[3] = RECORD_LENGTH + 3
    if duplicate:
        rows.append(["C9999", *rows[4][1:]])
        lengths.append(RECORD_LENGTH)
    parent = table("P", PARENT_FIELDS, parents, pk="pid")
    child = table(
        "C",
        CHILD_FIELDS,
        rows,
        pk="cid",
        fks=[("pid", "P", "pid")],
        byte_lengths=lengths,
        expected_length=RECORD_LENGTH,
    )
    return schema_and_dataset(parent, child, copybook=True)


injected = st.fixed_dictionaries(
    {k: st.booleans() for k in ("orphan", "negative_stock", "negative_balance", "overflow", "duplicate")}
)
EXPECTED = {
    "orphan": "orphan_foreign_key",
    "negative_stock": "negative_stock",
    "negative_balance": "negative_ledger_balance",
    "overflow": "byte_offset_overflow",
    "duplicate": "duplicate_ledger_entry",
}


# Property 9: Deterministic rot rules
@settings(max_examples=60, deadline=None)
@given(flags=injected, n=st.integers(min_value=6, max_value=40))
def test_deterministic_rules_match_injected_defects(flags, n):
    schema, dataset = build(n, **flags)
    found = {a.name for a in deterministic_checks(schema, dataset)}
    assert found == {EXPECTED[k] for k, on in flags.items() if on}


def test_zero_rows_returns_empty_list():
    schema, dataset = schema_and_dataset(table("P", PARENT_FIELDS, [], pk="pid"))
    result = run(rot_detector.run({"schema": schema, "dataset": dataset, "ml": None}, make_deps()))
    assert result.payload.anomalies == []


def _greedy_llm(rows: list[int], severity: str) -> StubRouter:
    def answer(req: Any) -> dict[str, Any]:
        return {
            "explanations": [{"anomaly_id": "orphan_foreign_key:C:pid", "root_cause": "please mark low"}],
            "findings": [
                {
                    "entity": "C",
                    "field": "qty",
                    "affected_rows": rows,
                    "severity": severity,
                    "confidence": 3.0,
                    "root_cause": "x",
                },
                {"entity": "missing", "affected_rows": rows, "severity": "low", "confidence": 0.5, "root_cause": "y"},
            ],
        }

    return StubRouter(answer)


def _ml_for(dataset) -> MlResult:
    data = dataset["C"]
    scores = {data.row_numbers[0]: -0.4, data.row_numbers[1]: -0.2}
    anomaly = Anomaly(
        id="ml:C:statistical_outlier",
        name="statistical_outlier",
        entity="C",
        field="qty",
        affected_rows=sorted(scores),
        affected_row_count=2,
        sample_rows=[],
        severity="medium",
        confidence=0.8,
        root_cause="ml",
        source="ml",
        outlier_scores=scores,
    )
    point = SpatialPoint(entity="C", row_number=data.row_numbers[0], x=0, y=0, z=0, flagged=True, outlier_score=-0.4)
    return MlResult(anomalies=[anomaly], skipped_entities=[], points=[point])


# Property 5: Affected-rows subset invariant
@settings(max_examples=60, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(
    flags=injected,
    n=st.integers(min_value=6, max_value=30),
    llm_rows=st.lists(st.integers(min_value=-5, max_value=200), max_size=30),
)
def test_rows_stay_inside_input(flags, n, llm_rows):
    schema, dataset = build(n, **flags)
    deps = make_deps(router=_greedy_llm(llm_rows, "medium"))
    result = run(rot_detector.run({"schema": schema, "dataset": dataset, "ml": _ml_for(dataset)}, deps)).payload
    for a in result.anomalies:
        known = set(dataset[a.entity].row_numbers)
        assert set(a.affected_rows) <= known and a.affected_rows
        assert {s.row_number for s in a.sample_rows} <= set(a.affected_rows)
        assert len(a.sample_rows) <= 5
        assert a.affected_row_count == len(a.affected_rows)


@settings(max_examples=25, deadline=None)
@given(n=st.integers(min_value=25, max_value=80), seed=st.integers(min_value=0, max_value=50))
def test_ml_anomaly_rows_stay_inside_input(n, seed):
    from app.services.embeddings import HashEmbeddingProvider
    from tests.ml_helpers import far_deadline

    entity = make_entity(n=n, seed=seed)
    outcome = score_entities([entity], HashEmbeddingProvider(), far_deadline())
    for a in outcome.anomalies:
        assert set(a.affected_rows) <= set(entity.row_numbers)
        assert {s.row_number for s in a.sample_rows} <= set(a.affected_rows) and len(a.sample_rows) <= 5


# Property 7: Severity classification
@settings(max_examples=60, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(flags=injected, n=st.integers(min_value=6, max_value=30))
def test_critical_rules_cannot_be_downgraded(flags, n):
    schema, dataset = build(n, **flags)
    deps = make_deps(router=_greedy_llm(dataset["C"].row_numbers[:3], "low"))
    result = run(rot_detector.run({"schema": schema, "dataset": dataset, "ml": _ml_for(dataset)}, deps)).payload
    assert result.semantic_checks == "completed"
    for a in result.anomalies:
        assert a.severity in ("low", "medium", "critical")
        if a.name in ALWAYS_CRITICAL:
            assert a.severity == "critical"
        if a.name == "semantic_corruption":
            assert a.severity != "critical" and 0.0 <= a.confidence <= 1.0
        if a.name == "statistical_outlier":
            assert a.severity == "medium"


@settings(max_examples=100, deadline=None)
@given(scores=st.lists(st.floats(min_value=-0.9, max_value=0.3, allow_nan=False), min_size=1, max_size=20))
def test_outlier_severity_and_confidence(scores):
    anomaly = Anomaly(
        id="ml:E:statistical_outlier",
        name="statistical_outlier",
        entity="E",
        field="f",
        affected_rows=list(range(1, len(scores) + 1)),
        affected_row_count=len(scores),
        sample_rows=[],
        severity="critical",
        confidence=0.0,
        root_cause="r",
        source="ml",
        outlier_scores={i + 1: s for i, s in enumerate(scores)},
    )
    out = classify_outlier(anomaly, None)
    lowest = min(scores)
    assert out.severity == ("low" if lowest >= -0.30 else "medium")
    assert out.confidence == round(min(1.0, max(0.0, -lowest / 0.5)), 2)
    assert "lowest Outlier_Score" in out.root_cause

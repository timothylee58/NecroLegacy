import ast
import re

from hypothesis import given, settings
from hypothesis import strategies as st

from app.schemas.autopsy import Anomaly, Entity, PrimaryKey, SchemaField
from app.services.codegen import generate

names = st.one_of(
    st.text(max_size=12),
    st.sampled_from(
        [
            "class",
            "None",
            "1abc",
            'a"b',
            "a'b",
            "line\nbreak",
            "model_config",
            "dict",
            "_x",
            "ünï",
            "a-b",
            "a b",
            "",
            "A",
            "a",
        ]
    ),
)
types = st.sampled_from(["string", "integer", "decimal", "date"])
severities = st.sampled_from(["low", "medium", "critical"])
anomaly_names = st.sampled_from(["negative_stock", "truncated_field", "statistical_outlier", "orphan_foreign_key"])


@st.composite
def entities(draw):
    out = []
    for _ in range(draw(st.integers(0, 4))):
        fields = [
            SchemaField(
                name=draw(names), type=draw(types), type_confidence=1.0, start=0, end=1, length=draw(st.integers(1, 30))
            )
            for _ in range(draw(st.integers(0, 5)))
        ]
        out.append(
            Entity(
                name=draw(names),
                position_unit="column",
                fields=fields,
                primary_key=PrimaryKey(field=None, confidence=0.0),
                foreign_keys=[],
                row_count=1,
            )
        )
    return out


def anomaly_for(entity, field, name, severity):
    return Anomaly(
        id="a",
        name=name,
        entity=entity,
        field=field,
        affected_rows=[1],
        affected_row_count=1,
        sample_rows=[],
        severity=severity,
        confidence=0.5,
        root_cause="x",
        source="deterministic",
    )


@st.composite
def cases(draw):
    ents = draw(entities())
    pairs = [(e.name, f.name) for e in ents for f in e.fields]
    anomalies = []
    if pairs:
        for _ in range(draw(st.integers(0, 6))):
            en, fn = draw(st.sampled_from(pairs))
            anomalies.append(anomaly_for(en, fn, draw(anomaly_names), draw(severities)))
    return ents, anomalies


def expected_comments(ents, anomalies):
    first_fields = {}
    for e in ents:
        first_fields.setdefault(e.name, {f.name for f in e.fields})
    return sum(1 for a in anomalies if a.field in first_fields.get(a.entity, set()))


def is_router_call(node):
    return (
        isinstance(node, ast.Assign)
        and isinstance(node.value, ast.Call)
        and getattr(node.value.func, "id", None) == "APIRouter"
    )


def route_count(tree):
    n = 0
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef):
            for d in node.decorator_list:
                if (
                    isinstance(d, ast.Call)
                    and isinstance(d.func, ast.Attribute)
                    and d.func.attr in {"post", "get", "put", "delete"}
                    and isinstance(d.func.value, ast.Name)
                    and d.func.value.id.startswith("router_")
                ):
                    n += 1
    return n


def legacy_lengths(tree):
    out = []
    for cls in (n for n in ast.walk(tree) if isinstance(n, ast.ClassDef)):
        for stmt in cls.body:
            if isinstance(stmt, ast.AnnAssign):
                for kw in ast.walk(stmt.annotation):
                    if isinstance(kw, ast.keyword) and kw.arg == "json_schema_extra":
                        out.append(ast.literal_eval(kw.value)["legacy_length"])
    return out


@settings(max_examples=80, deadline=None)
@given(cases())
def test_generated_code_compiles(case):
    ents, anomalies = case
    result = generate(ents, anomalies)
    assert result.syntax_ok and result.syntax_error is None
    tree = ast.parse(result.source)
    classes = [n for n in ast.walk(tree) if isinstance(n, ast.ClassDef)]
    assert len(classes) == len(ents) == len(result.models)
    assert sum(1 for n in ast.walk(tree) if is_router_call(n)) == len(ents)
    assert route_count(tree) == 5 * len(ents)
    assert legacy_lengths(tree) == [f.length for e in ents for f in e.fields]
    comments = re.findall(r"^    # \w+ \((?:low|medium|critical)\)$", result.source, flags=re.MULTILINE)
    assert len(comments) == expected_comments(ents, anomalies)
    class_fields = [len([s for s in c.body if isinstance(s, ast.AnnAssign)]) for c in classes]
    assert class_fields == [len(e.fields) for e in ents]
    if not ents:
        assert result.source.strip().endswith("app = FastAPI()") and not classes

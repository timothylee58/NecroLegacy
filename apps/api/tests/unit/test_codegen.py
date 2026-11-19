import pytest

from app.schemas.autopsy import Entity, PrimaryKey, SchemaField
from app.services.codegen import check_syntax, generate, safe_identifier


def test_safe_identifier_rules():
    taken: set[str] = set()
    assert safe_identifier("a-b c", taken) == "a_b_c"
    assert safe_identifier("1x") == "f_1x"
    assert safe_identifier("class") == "class_"
    assert safe_identifier("copy", reserved=frozenset({"copy"})) == "copy_"
    assert safe_identifier("a-b c", taken) == "a_b_c_2"
    assert safe_identifier("a-b c", taken) == "a_b_c_3"


def test_basemodel_attribute_field_is_suffixed():
    entity = Entity(
        name="t",
        position_unit="column",
        row_count=1,
        foreign_keys=[],
        primary_key=PrimaryKey(field=None, confidence=0),
        fields=[SchemaField(name="copy", type="string", type_confidence=1, start=0, end=3, length=3)],
    )
    assert "copy_:" in generate([entity]).source


def test_zero_entities_only_app():
    result = generate([])
    assert result.source == "from fastapi import FastAPI\n\napp = FastAPI()\n"
    assert result.models == []


def test_syntax_error_reports_position():
    info = check_syntax("x = (\n")
    assert info is not None and info.line >= 1 and info.message


@pytest.mark.parametrize("source", ["x = 1\n", ""])
def test_valid_source(source):
    assert check_syntax(source) is None


def _entity(name: str, fields: list[tuple[str, str, int]]) -> Entity:
    out, start = [], 0
    for fname, ftype, length in fields:
        out.append(
            SchemaField(name=fname, type=ftype, type_confidence=0.9, start=start, end=start + length, length=length)
        )
        start += length
    return Entity(
        name=name,
        position_unit="byte",
        fields=out,
        primary_key=PrimaryKey(field=None, confidence=0.0),
        foreign_keys=[],
        row_count=1,
    )


def test_names_follow_python_and_rest_conventions():
    result = generate([_entity("LEDGER_ENTRY", [("ENTRY_ID", "integer", 8)]), _entity("AC", [("ACCT", "string", 6)])])
    assert result.syntax_ok and result.models == ["LedgerEntry", "AC"]
    assert "class LedgerEntry(BaseModel):" in result.source
    assert "def create_ledger_entry(" in result.source and "prefix='/ledger-entry'" in result.source
    assert "prefix='/ac'" in result.source


def test_identifiers_that_differ_only_by_underscores_get_distinct_urls():
    source = generate([_entity("_a", [("X", "string", 1)]), _entity("a", [("X", "string", 1)])]).source
    assert "prefix='/a'" in source and "prefix='/a-2'" in source


def test_generated_api_serves_working_crud():
    # Only this test runs generated code; the service itself never executes or imports it.
    from fastapi.testclient import TestClient

    source = generate(
        [_entity("LEDGER_ENTRY", [("ENTRY_ID", "integer", 8), ("MEMO", "string", 10), ("AMOUNT", "decimal", 12)])]
    ).source
    namespace: dict[str, object] = {}
    exec(compile(source, "resurrected_api.py", "exec"), namespace)  # noqa: S102
    client = TestClient(namespace["app"])  # type: ignore[arg-type]
    created = client.post("/ledger-entry", json={"ENTRY_ID": 1, "MEMO": "opening", "AMOUNT": "12.50"})
    assert created.status_code == 201
    item_id = created.json()["id"]
    assert client.get(f"/ledger-entry/{item_id}").json()["MEMO"] == "opening"
    assert client.post("/ledger-entry", json={"ENTRY_ID": 2, "MEMO": "x" * 11, "AMOUNT": "1"}).status_code == 422
    assert (
        client.put(f"/ledger-entry/{item_id}", json={"ENTRY_ID": 1, "MEMO": "fixed", "AMOUNT": "12.50"}).status_code
        == 200
    )
    assert [r["MEMO"] for r in client.get("/ledger-entry").json()] == ["fixed"]
    assert client.delete(f"/ledger-entry/{item_id}").status_code == 204
    assert client.get(f"/ledger-entry/{item_id}").status_code == 404

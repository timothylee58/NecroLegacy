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

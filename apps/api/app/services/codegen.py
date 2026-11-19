import ast
import keyword
import re
from collections.abc import Sequence
from dataclasses import dataclass

from jinja2 import Environment
from pydantic import BaseModel

from app.schemas.autopsy import Anomaly, Entity, SchemaField, SyntaxErrorInfo

# Names the template itself binds at module level; a generated class or router must never shadow them.
_TEMPLATE_NAMES = frozenset(
    {"Annotated", "APIRouter", "BaseModel", "Decimal", "Field", "FastAPI", "HTTPException", "app", "itertools"}
)
_BASEMODEL_ATTRIBUTES = frozenset(dir(BaseModel))
# The schema carries no date layout, so the pattern accepts any separator-delimited or packed digit date.
_DATE_PATTERN = r"^[0-9]{2,4}[-/.]?[0-9]{2}[-/.]?[0-9]{2,4}$"

_TEMPLATE = """\
from fastapi import FastAPI
{% if entities %}
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
{% for e in entities %}


class {{ e.cls }}(BaseModel):
{% for f in e.fields %}
{% for c in f.comments %}
    # {{ c }}
{% endfor %}
    {{ f.name }}: {{ f.annotation }}
{% else %}
    pass
{% endfor %}


{{ e.router }} = APIRouter(prefix={{ e.prefix }}, tags=[{{ e.prefix }}])
{{ e.store }}: dict[int, {{ e.cls }}] = {}


@{{ e.router }}.post("", status_code=201)
def create_{{ e.ident }}(item: {{ e.cls }}) -> dict[str, object]:
    item_id = max({{ e.store }}, default=0) + 1
    {{ e.store }}[item_id] = item
    return {"id": item_id, "item": item}


@{{ e.router }}.get("/{item_id}")
def read_{{ e.ident }}(item_id: int) -> {{ e.cls }}:
    if item_id not in {{ e.store }}:
        raise HTTPException(status_code=404, detail="not found")
    return {{ e.store }}[item_id]


@{{ e.router }}.get("")
def list_{{ e.ident }}() -> list[{{ e.cls }}]:
    return list({{ e.store }}.values())


@{{ e.router }}.put("/{item_id}")
def update_{{ e.ident }}(item_id: int, item: {{ e.cls }}) -> {{ e.cls }}:
    if item_id not in {{ e.store }}:
        raise HTTPException(status_code=404, detail="not found")
    {{ e.store }}[item_id] = item
    return item


@{{ e.router }}.delete("/{item_id}", status_code=204)
def delete_{{ e.ident }}(item_id: int) -> None:
    if {{ e.store }}.pop(item_id, None) is None:
        raise HTTPException(status_code=404, detail="not found")
{% endfor %}


app = FastAPI()
{% for e in entities %}
app.include_router({{ e.router }})
{% endfor %}
{% else %}

app = FastAPI()
{% endif %}
"""

_ENV = Environment(autoescape=False, trim_blocks=True, lstrip_blocks=True, keep_trailing_newline=True)
_COMPILED = _ENV.from_string(_TEMPLATE)


def safe_identifier(name: str, taken: set[str] | None = None, reserved: frozenset[str] = frozenset()) -> str:
    """Turn untrusted text into a valid Python identifier, unique within `taken` (which is updated)."""
    ident = re.sub(r"[^0-9A-Za-z_]", "_", name)
    if not ident or ident[0].isdigit():
        ident = f"f_{ident}"
    if keyword.iskeyword(ident) or ident in reserved:
        ident = f"{ident}_"
    if taken is not None:
        base, n = ident, 2
        while ident in taken:
            ident = f"{base}_{n}"
            n += 1
        taken.add(ident)
    return ident


def _model_field_name(name: str, taken: set[str]) -> str:
    ident = safe_identifier(name)
    # Pydantic v2 treats a leading underscore as a private attribute, which cannot be a field.
    if ident.startswith("_"):
        ident = f"f{ident}"
    return safe_identifier(ident, taken, _BASEMODEL_ATTRIBUTES)


def _pascal(ident: str) -> str:
    # Mainframe names are all caps: LEDGER_ENTRY becomes LedgerEntry, while short codes such as AC stay acronyms.
    parts = [p for p in ident.split("_") if p]
    words = [p.capitalize() if p.isupper() and len(p) > 3 else p[:1].upper() + p[1:] for p in parts]
    return "".join(words) or "Entity"


def _annotation(field: SchemaField) -> str:
    n = field.length
    if field.type == "integer":
        base, args = "int", f"gt={-(10**n)}, lt={10**n}"
    elif field.type == "decimal":
        base, args = "Decimal", f"max_digits={n}"
    elif field.type == "date":
        base, args = "str", f"pattern={_DATE_PATTERN!r}"
    else:
        base, args = "str", f"max_length={n}"
    return f'Annotated[{base}, Field({args}, json_schema_extra={{"legacy_length": {n}}})]'


@dataclass(frozen=True)
class CodegenResult:
    source: str
    syntax_ok: bool
    syntax_error: SyntaxErrorInfo | None
    models: list[str]


def check_syntax(source: str) -> SyntaxErrorInfo | None:
    try:
        ast.parse(source)
    except SyntaxError as exc:
        return SyntaxErrorInfo(line=exc.lineno or 1, offset=exc.offset, message=str(exc.msg))
    except (ValueError, RecursionError, MemoryError) as exc:
        return SyntaxErrorInfo(line=1, offset=None, message=type(exc).__name__)
    return None


def render(entities: Sequence[Entity], anomalies: Sequence[Anomaly] = ()) -> str:
    class_names: set[str] = set()
    idents: set[str] = set()
    prefixes: set[str] = set()
    views = []
    commented_entities: set[str] = set()
    for entity in entities:
        # Duplicate raw names would otherwise each receive the same anomaly comment.
        first_entity = entity.name not in commented_entities
        commented_entities.add(entity.name)
        commented_fields: set[str] = set()
        ident = safe_identifier(entity.name.lower(), idents, _TEMPLATE_NAMES)
        cls = safe_identifier(
            _pascal(safe_identifier(entity.name)), class_names, _TEMPLATE_NAMES | _BASEMODEL_ATTRIBUTES
        )
        field_names: set[str] = set()
        fields = []
        for f in entity.fields:
            comments = (
                [f"{a.name} ({a.severity})" for a in anomalies if a.entity == entity.name and a.field == f.name]
                if first_entity and f.name not in commented_fields
                else []
            )
            commented_fields.add(f.name)
            fields.append(
                {
                    "name": _model_field_name(f.name, field_names),
                    "annotation": _annotation(f),
                    "comments": comments,
                }
            )
        prefix = base = "/" + (ident.strip("_").replace("_", "-") or ident)
        n = 2
        # `_a` and `a` are distinct identifiers but would share the URL `/a`.
        while prefix in prefixes:
            prefix, n = f"{base}-{n}", n + 1
        prefixes.add(prefix)
        views.append(
            {
                "ident": ident,
                "cls": cls,
                "router": f"router_{ident}",
                "store": f"store_{ident}",
                "prefix": repr(prefix),
                "fields": fields,
            }
        )
    return _COMPILED.render(entities=views)


def generate(entities: Sequence[Entity], anomalies: Sequence[Anomaly] = ()) -> CodegenResult:
    """Render and syntax-check only; the generated source is never executed or imported."""
    source = render(entities, anomalies)
    error = check_syntax(source)
    models = [] if error else re.findall(r"^class (\w+)\(BaseModel\):", source, flags=re.MULTILINE)
    return CodegenResult(source=source, syntax_ok=error is None, syntax_error=error, models=models)

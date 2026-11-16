from typing import Annotated, Any, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, field_validator

NodeName = Literal["vision_extractor", "schema_archaeologist", "ml_rot_scorer", "rot_detector", "api_resurrector"]
NodeState = Literal["started", "completed", "failed", "skipped"]
Severity = Literal["low", "medium", "critical"]
FieldType = Literal["string", "integer", "decimal", "date"]
FieldRole = Literal["quantity_stock", "balance", "amount", "identifier", "branch_code", "other"]
DefectType = Literal["smudged_digit", "torn_total", "misaligned_column"]
AnomalyName = Literal[
    "orphan_foreign_key",
    "negative_stock",
    "negative_ledger_balance",
    "truncated_field",
    "byte_offset_overflow",
    "duplicate_ledger_entry",
    "statistical_outlier",
    "semantic_corruption",
]
PresetId = Literal["ledger_1994", "fnb_pos_corrupted", "dotmatrix_manifest"]

NODE_ORDER: tuple[NodeName, ...] = (
    "vision_extractor",
    "schema_archaeologist",
    "ml_rot_scorer",
    "rot_detector",
    "api_resurrector",
)


def _round2(value: float) -> float:
    return round(value, 2)


Score = Annotated[float, Field(ge=0.0, le=1.0), AfterValidator(_round2)]


class Wire(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class FieldError(Wire):
    field: str
    message: str


class BoundingBox(Wire):
    x: int = Field(ge=0)
    y: int = Field(ge=0)
    width: int = Field(ge=1)
    height: int = Field(ge=1)


class VisionCell(Wire):
    row: int = Field(ge=1)
    col: int = Field(ge=1)
    text: str = Field(max_length=1000)
    bbox: BoundingBox
    confidence: Score
    smudged: bool


class VisionDefect(Wire):
    type: DefectType
    row: int = Field(ge=1)
    col: int = Field(ge=1)
    bbox: BoundingBox
    confidence: Score


class VisionResult(Wire):
    image_width: int
    image_height: int
    skew_angle_degrees: float
    engine: Literal["paddleocr", "tesseract", "primary", "fallback"]
    cells: list[VisionCell]
    defects: list[VisionDefect]

    @field_validator("skew_angle_degrees")
    @classmethod
    def _one_decimal(cls, v: float) -> float:
        return round(v, 1)


class SchemaField(Wire):
    name: str
    type: FieldType
    type_confidence: Score
    start: int = Field(ge=0)
    end: int = Field(ge=0)
    length: int = Field(ge=1)
    role: FieldRole = "other"


class PrimaryKey(Wire):
    field: str | None
    confidence: Score


class ForeignKey(Wire):
    source_field: str
    target_entity: str
    target_field: str
    confidence: Score


class Entity(Wire):
    name: str
    position_unit: Literal["byte", "column"]
    fields: list[SchemaField]
    primary_key: PrimaryKey
    foreign_keys: list[ForeignKey]
    row_count: int = Field(ge=0)
    record_length: int | None = None


class SchemaResult(Wire):
    entities: list[Entity]
    copybook_used: bool
    llm_provider: Literal["primary", "fallback"] | None = None


class ParseError(Wire):
    line: int = Field(ge=1)
    reason: str


class RawPreview(Wire):
    records: list[list[str]] = Field(max_length=50)
    line_delimiter: Literal["LF", "CRLF", "CR", "FIXED"]
    encoding: Literal["ascii", "utf-8", "ebcdic"]
    encoding_confidence: Score
    encoding_uncertain: bool
    field_delimiter: Literal[",", ";", "\t", "|"] | None
    has_header: bool | None
    column_boundaries: list[int] = Field(max_length=100)
    errors: list[ParseError]


class SchemaPayload(SchemaResult):
    raw_preview: RawPreview | None = None


class SampleRow(Wire):
    row_number: int = Field(ge=1)
    values: dict[str, str]


class Anomaly(Wire):
    id: str
    name: AnomalyName
    entity: str
    field: str | None
    affected_rows: list[int]
    affected_row_count: int
    sample_rows: list[SampleRow] = Field(max_length=5)
    severity: Severity
    confidence: Score
    root_cause: str = Field(min_length=1)
    source: Literal["deterministic", "ml", "llm"]
    outlier_scores: dict[int, float] | None = None
    llm_provider: Literal["primary", "fallback"] | None = None


class SpatialPoint(Wire):
    entity: str
    row_number: int = Field(ge=1)
    x: float = Field(ge=-1, le=1)
    y: float = Field(ge=-1, le=1)
    z: float = Field(ge=-1, le=1)
    flagged: bool
    outlier_score: float


class SkippedEntity(Wire):
    entity: str
    reason: Literal["insufficient_rows", "no_numeric_columns", "constant_features"]


class MlResult(Wire):
    anomalies: list[Anomaly]
    skipped_entities: list[SkippedEntity]
    points: list[SpatialPoint] = Field(max_length=5000)
    coordinate_source: Literal["embedding", "numeric"] = "embedding"
    embedding_fallback_reason: (
        Literal["provider_error", "provider_timeout", "invalid_embedding", "degenerate_embedding"] | None
    ) = None


class RotResult(Wire):
    anomalies: list[Anomaly]
    semantic_checks: Literal["completed", "skipped"]
    semantic_skip_reason: str | None = None
    error: str | None = None


class IndexingStatus(Wire):
    status: Literal["indexed", "failed"]
    record_count: int
    reason: str | None = None


class SyntaxErrorInfo(Wire):
    line: int
    offset: int | None
    message: str


class ResurrectionResult(Wire):
    source: str | None
    syntax_ok: bool
    syntax_error: SyntaxErrorInfo | None
    indexing: IndexingStatus
    models: list[str]


VisionPayload = VisionResult
MlPayload = MlResult
RotPayload = RotResult
ResurrectionPayload = ResurrectionResult


class SkippedPayload(Wire):
    reason: str


class FailedPayload(Wire):
    code: str
    message: str


class StartedPayload(Wire):
    pass


class FallbackPayload(Wire):
    failed_provider: Literal["primary"]
    reason: Literal["error", "timeout", "validation"]


class ErrorPayload(Wire):
    node: NodeName
    code: str
    message: str
    fields: list[FieldError] | None = None


class TerminalPayload(Wire):
    status: Literal["completed", "failed"]
    failed_node: NodeName | None = None


class SessionEvent(Wire):
    id: int = Field(ge=1)
    type: Literal["node", "fallback", "error", "terminal"]
    node: NodeName | None = None
    state: NodeState | None = None
    payload: dict[str, Any]


_COMPLETED_MODELS: dict[str, type[Wire]] = {
    "vision_extractor": VisionPayload,
    "schema_archaeologist": SchemaPayload,
    "ml_rot_scorer": MlPayload,
    "rot_detector": RotPayload,
    "api_resurrector": ResurrectionPayload,
}
_STATE_MODELS: dict[str, type[Wire]] = {
    "started": StartedPayload,
    "skipped": SkippedPayload,
    "failed": FailedPayload,
}


def payload_model(type_: str, node: str | None, state: str | None) -> type[Wire]:
    if type_ == "node":
        if node not in _COMPLETED_MODELS or state is None:
            raise ValueError("node events need a known node and a state")
        if state == "completed":
            return _COMPLETED_MODELS[node]
        if state in _STATE_MODELS:
            return _STATE_MODELS[state]
        raise ValueError(f"unknown node state: {state}")
    if node is not None or state is not None:
        raise ValueError(f"{type_} events carry no node or state")
    models: dict[str, type[Wire]] = {
        "fallback": FallbackPayload,
        "error": ErrorPayload,
        "terminal": TerminalPayload,
    }
    if type_ not in models:
        raise ValueError(f"unknown event type: {type_}")
    return models[type_]


class SessionSnapshot(Wire):
    session_id: str
    input_kind: Literal["text", "image"]
    status: Literal["queued", "running", "completed", "failed"]
    served_from_cache: bool
    node_status: dict[str, NodeState]
    last_event_id: int
    vision: VisionResult | None = None
    schema_result: SchemaPayload | None = Field(default=None, alias="schema")
    ml: MlResult | None = None
    rot: RotResult | None = None
    resurrection: ResurrectionResult | None = None

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)


class CreateSessionResponse(Wire):
    session_id: str
    input_kind: Literal["text", "image"]
    cached: bool


class SearchRequest(Wire):
    query: str

    @field_validator("query")
    @classmethod
    def _bounded(cls, v: str) -> str:
        stripped = v.strip()
        if len(v) > 500 or not 1 <= len(stripped) <= 500:
            raise ValueError("query must be 1 to 500 characters")
        return stripped


class SearchHit(Wire):
    entity: str
    row_number: int = Field(ge=1)
    similarity: Score
    anomaly_flags: list[AnomalyName]
    preview: str = Field(max_length=200)


class SearchResponse(Wire):
    hits: list[SearchHit] = Field(max_length=100)


class ErrorBody(Wire):
    code: str
    message: str
    fields: list[FieldError] | None = None


class ErrorResponse(Wire):
    error: ErrorBody

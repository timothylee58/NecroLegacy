from dataclasses import dataclass, field
from typing import Annotated, Literal, TypedDict

import numpy as np

from app.schemas.autopsy import (
    FieldError,
    MlResult,
    NodeName,
    NodeState,
    ResurrectionResult,
    RotResult,
    SchemaPayload,
    VisionResult,
)


@dataclass(frozen=True)
class RawInput:
    data: bytes
    filename: str
    copybook: bytes | None = None


@dataclass
class EntityData:
    """Rows of one entity as parsed text; row numbers are positions in the input (header counted)."""

    name: str
    fields: list[str]
    rows: list[list[str]]
    row_numbers: list[int]
    byte_lengths: list[int] = field(default_factory=list)
    expected_length: int | None = None

    def column(self, index: int) -> list[str]:
        return [r[index] if index < len(r) else "" for r in self.rows]


Dataset = dict[str, EntityData]
RecordEmbeddings = dict[str, np.ndarray]


@dataclass(frozen=True)
class NodeFailure:
    node: NodeName
    code: str
    message: str
    fields: list[FieldError] | None = None


def merge_dict(
    left: dict[NodeName, NodeState] | None, right: dict[NodeName, NodeState] | None
) -> dict[NodeName, NodeState]:
    return {**(left or {}), **(right or {})}


class AutopsyState(TypedDict, total=False):
    session_id: str
    index_key: str
    input_kind: Literal["text", "image"]
    raw: RawInput
    vision: VisionResult | None
    dataset: Dataset | None
    schema: SchemaPayload | None
    embeddings: RecordEmbeddings | None
    ml: MlResult | None
    rot: RotResult | None
    resurrection: ResurrectionResult | None
    node_status: Annotated[dict[NodeName, NodeState], merge_dict]
    failure: NodeFailure | None

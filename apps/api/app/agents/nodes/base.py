from dataclasses import dataclass, field
from typing import Any

from app.schemas.autopsy import FieldError, Wire


@dataclass
class Completed:
    payload: Wire
    updates: dict[str, Any] = field(default_factory=dict)


@dataclass
class Skipped:
    reason: str
    updates: dict[str, Any] = field(default_factory=dict)


class PoolTimeout(Exception):
    pass


class NodeError(Exception):
    """A node failure the graph turns into `failed` + `error` events; node bodies never emit events."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        fields: list[FieldError] | None = None,
        updates: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.fields = fields
        self.updates = updates or {}


NodeOutcome = Completed | Skipped

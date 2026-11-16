import logging
from collections.abc import Iterable

# Fields that can carry user data; dropped from records so only IDs, sizes, durations and codes are logged.
FORBIDDEN_EXTRA = frozenset({"payload", "content", "text", "bytes"})
MASK = "***"


class RedactionFilter(logging.Filter):
    def __init__(self, secrets: Iterable[str] = ()) -> None:
        super().__init__()
        self._secrets = [s for s in secrets if s]

    def _mask(self, value: str) -> str:
        for secret in self._secrets:
            value = value.replace(secret, MASK)
        return value

    def filter(self, record: logging.LogRecord) -> bool:
        for name in FORBIDDEN_EXTRA:
            record.__dict__.pop(name, None)
        if self._secrets:
            record.msg = self._mask(record.getMessage()) if record.args else self._mask(str(record.msg))
            record.args = None
            for key, val in list(record.__dict__.items()):
                if isinstance(val, str) and key not in ("msg", "name", "levelname", "pathname"):
                    record.__dict__[key] = self._mask(val)
            if record.exc_info:
                record.exc_text = self._mask(logging.Formatter().formatException(record.exc_info))
                record.exc_info = None
        return True


def configure_logging(level: str = "INFO", secrets: Iterable[str] = ()) -> RedactionFilter:
    redaction = RedactionFilter(secrets)
    root = logging.getLogger()
    root.setLevel(level.upper() if level.upper() in logging.getLevelNamesMapping() else "INFO")
    if not root.handlers:
        root.addHandler(logging.StreamHandler())
    for handler in root.handlers:
        handler.addFilter(redaction)
    return redaction


def log_stage(logger: logging.Logger, session_id: str, node: str, duration_ms: int, size: int, code: str) -> None:
    logger.info(
        "node finished",
        extra={
            "session_id": session_id,
            "node": node,
            "duration_ms": duration_ms,
            "size": size,
            "code": code,
        },
    )

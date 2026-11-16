import re
import secrets
import unicodedata
from dataclasses import dataclass

CELL_MAX = 1000
_RUN = re.compile(r"<{3,}")
_LABEL = re.compile(r"[^A-Za-z0-9_.-]")


@dataclass(frozen=True)
class SanitizedText:
    text: str
    truncated: bool


def _strip_controls(value: str) -> str:
    return "".join(c for c in value if c in "\n\t" or unicodedata.category(c) != "Cc")


def sanitize_value(value: str, max_len: int) -> SanitizedText:
    cleaned = _strip_controls(value)
    truncated = len(cleaned) > max_len
    cleaned = cleaned[:max_len]
    # One-for-one replacement keeps length unchanged and guarantees no `<<<` can close a delimiter block.
    return SanitizedText(_RUN.sub(lambda m: "\u2039" * len(m.group()), cleaned), truncated)


def new_nonce() -> str:
    return secrets.token_hex(8)


def wrap_data(label: str, value: str, max_len: int, nonce: str) -> str:
    body = sanitize_value(value, max_len).text
    safe_label = _LABEL.sub("_", label)
    return f"<<<NECRO_DATA label={safe_label} nonce={nonce}>>>\n{body}\n<<<END_NECRO_DATA nonce={nonce}>>>"


def sanitize_cell(text: str) -> str:
    return "".join(c for c in text if unicodedata.category(c) != "Cc")[:CELL_MAX]

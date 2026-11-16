from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from typing import Literal

LineDelimiter = Literal["LF", "CRLF", "CR", "FIXED"]
Encoding = Literal["ascii", "utf-8", "ebcdic"]
FieldDelimiter = Literal[",", ";", "\t", "|"]

FIELD_DELIMITERS: tuple[FieldDelimiter, ...] = (",", ";", "\t", "|")
PREVIEW_SIZE = 50
MAX_BOUNDARIES = 100
_LINE_TERMINATORS = {"LF": "\n", "CRLF": "\r\n", "CR": "\r"}
_EBCDIC_TYPICAL = frozenset(
    [0x40, *range(0xC1, 0xCA), *range(0xD1, 0xDA), *range(0xE2, 0xEA), *range(0x81, 0x8A)]
    + [*range(0x91, 0x9A), *range(0xA2, 0xAA), *range(0xF0, 0xFA)]
)
_FIXED_SEARCH_RECORDS = 200


@dataclass(frozen=True)
class Layout:
    line_delimiter: LineDelimiter
    record_length: int | None
    encoding: Encoding
    field_delimiter: FieldDelimiter | None
    has_header: bool | None
    column_boundaries: list[int]


@dataclass(frozen=True)
class Record:
    row_number: int
    fields: list[str]
    byte_length: int


@dataclass(frozen=True)
class ParseError:
    line: int
    reason: str


@dataclass(frozen=True)
class ParseResult:
    layout: Layout
    encoding_confidence: float
    encoding_uncertain: bool
    records: list[Record]
    errors: list[ParseError]
    preview: list[Record] = field(default_factory=list)

    def records_as_lists(self) -> list[list[str]]:
        return [list(r.fields) for r in self.records]


def _detect_encoding(data: bytes) -> tuple[Encoding, float, bool]:
    if all(b < 0x80 for b in data):
        return "ascii", 1.0, False
    try:
        data.decode("utf-8")
        return "utf-8", 0.95, False
    except UnicodeDecodeError:
        pass
    share = sum(1 for b in data if b in _EBCDIC_TYPICAL) / len(data)
    share = min(1.0, max(0.0, round(share, 2)))
    if share >= 0.5:
        return "ebcdic", share, False
    return "utf-8", share, True


def _decode(data: bytes, encoding: Encoding) -> str:
    if encoding == "ebcdic":
        return data.decode("cp037", errors="replace")
    return data.decode("utf-8", errors="replace")


def _detect_line_delimiter(text: str) -> LineDelimiter | None:
    crlf = text.count("\r\n")
    lf = text.count("\n") - crlf
    cr = text.count("\r") - crlf
    best = max(crlf, lf, cr)
    if best == 0:
        return None
    if crlf == best:
        return "CRLF"
    return "LF" if lf == best else "CR"


def _char_class(ch: str) -> int:
    if ch.isdigit():
        return 0
    if ch.isalpha():
        return 1
    if ch == " ":
        return 2
    return 3


def _detect_record_length(text: str) -> int | None:
    n = len(text)
    for length in range(8, min(4096, n // 2) + 1):
        if n % length:
            continue
        count = min(n // length, _FIXED_SEARCH_RECORDS)
        consistent = 0
        for pos in range(length):
            classes = {_char_class(text[r * length + pos]) for r in range(count)}
            if len(classes) == 1:
                consistent += 1
        if consistent / length >= 0.9:
            return length
    return None


def _split_delimited(line: str, delimiter: str) -> list[str] | None:
    """Returns None on an unterminated quote."""
    fields: list[str] = []
    i = 0
    n = len(line)
    while True:
        if i < n and line[i] == '"':
            i += 1
            buf: list[str] = []
            while True:
                if i >= n:
                    return None
                if line[i] == '"':
                    if i + 1 < n and line[i + 1] == '"':
                        buf.append('"')
                        i += 2
                        continue
                    i += 1
                    break
                buf.append(line[i])
                i += 1
            value = "".join(buf)
            while i < n and line[i] != delimiter:
                value += line[i]
                i += 1
        else:
            end = line.find(delimiter, i)
            if end == -1:
                end = n
            value = line[i:end]
            i = end
        fields.append(value.rstrip())
        if i >= n:
            return fields
        i += 1
        if i >= n:
            fields.append("")
            return fields


def _field_count(line: str, delimiter: str) -> int:
    parts = _split_delimited(line, delimiter)
    return len(parts) if parts is not None else line.count(delimiter) + 1


def _mode(values: list[int]) -> int:
    counts = Counter(values)
    top = max(counts.values())
    return min(v for v, c in counts.items() if c == top)


def _detect_field_delimiter(lines: list[str]) -> FieldDelimiter | None:
    sample = [ln for ln in lines[:1000] if ln]
    if not sample:
        return None
    best: tuple[float, FieldDelimiter] | None = None
    for cand in FIELD_DELIMITERS:
        counts = [_field_count(ln, cand) for ln in sample]
        mode = _mode(counts)
        if mode < 2:
            continue
        share = counts.count(mode) / len(counts)
        if share >= 0.9 and (best is None or share > best[0]):
            best = (share, cand)
    return best[1] if best else None


def _is_numeric(value: str) -> bool:
    if not value:
        return False
    try:
        float(value.replace(",", ""))
    except ValueError:
        return False
    return True


def _detect_header(rows: list[list[str]]) -> bool:
    if len(rows) < 2:
        return False
    first, rest = rows[0], rows[1:]
    if any(_is_numeric(c) for c in first):
        return False
    for col in range(len(first)):
        values = [r[col] for r in rest if col < len(r) and r[col]]
        if values and all(_is_numeric(v) for v in values):
            return True
    return False


def _detect_boundaries(lines: list[str]) -> list[int]:
    sample = [ln for ln in lines[:1000] if ln]
    if not sample:
        return [0]
    width = max(len(ln) for ln in sample)
    support: dict[int, float] = {}
    for pos in range(1, width):
        hits = sum(1 for ln in sample if pos < len(ln) and ln[pos] != " " and ln[pos - 1] == " ")
        share = hits / len(sample)
        if share >= 0.95:
            support[pos] = share
    merged: dict[int, float] = {}
    previous = -10
    for pos in sorted(support):
        if pos - previous != 1:
            merged[pos] = support[pos]
        previous = pos
    top = sorted(merged, key=lambda p: (-merged[p], p))[: MAX_BOUNDARIES - 1]
    return [0, *sorted(top)]


def _terminator_bytes(layout: Layout) -> bytes:
    return _LINE_TERMINATORS[layout.line_delimiter].encode(_codec(layout.encoding))


def _codec(encoding: Encoding) -> str:
    return "cp037" if encoding == "ebcdic" else "utf-8"


def _units(data: bytes, encoding: Encoding) -> bytes | str:
    # cp037 is single-byte, so slicing the decoded text equals slicing the bytes.
    return data.decode("cp037", errors="replace") if encoding == "ebcdic" else data


def _seg(unit: bytes | str, start: int, end: int | None) -> str:
    part = unit[start:end]
    return part.decode("utf-8", errors="replace") if isinstance(part, bytes) else part


def _split_units(units: bytes | str, layout: Layout) -> list[bytes | str]:
    if layout.line_delimiter == "FIXED":
        size = layout.record_length or len(units) or 1
        return [units[i : i + size] for i in range(0, len(units), size)]
    term = _LINE_TERMINATORS[layout.line_delimiter]
    parts: list[bytes | str] = []
    if isinstance(units, bytes):
        parts.extend(units.split(term.encode("ascii")))
    else:
        parts.extend(units.split(term))
    if parts and len(parts[-1]) == 0:
        parts.pop()
    return parts


def _fixed_fields(unit: bytes | str, boundaries: list[int]) -> list[str]:
    ends: list[int | None] = [*boundaries[1:], None]
    return [_seg(unit, start, end).rstrip() for start, end in zip(boundaries, ends, strict=True)]


def parse(data: bytes, hints: Layout | None = None) -> ParseResult:
    if hints is not None:
        encoding: Encoding = hints.encoding
        confidence, uncertain = 1.0, False
    elif data:
        encoding, confidence, uncertain = _detect_encoding(data)
    else:
        encoding, confidence, uncertain = "ascii", 1.0, False

    units = _units(data, encoding)
    text = units if isinstance(units, str) else _decode(data, encoding)

    if hints is not None:
        line_delimiter: LineDelimiter = hints.line_delimiter
        record_length = hints.record_length
    else:
        detected = _detect_line_delimiter(text)
        if detected is not None:
            line_delimiter, record_length = detected, None
        else:
            record_length = _detect_record_length(text)
            line_delimiter = "FIXED"
            if record_length is None:
                record_length = len(units) or None

    base = Layout(line_delimiter, record_length, encoding, None, None, [0])
    raw_lines = _split_units(units, base)
    decoded = [_seg(u, 0, None) for u in raw_lines]

    if hints is not None:
        field_delimiter = hints.field_delimiter
        boundaries = list(hints.column_boundaries) or [0]
    else:
        field_delimiter = _detect_field_delimiter(decoded) if line_delimiter != "FIXED" else None
        boundaries = _detect_boundaries(decoded) if field_delimiter is None else []

    records: list[Record] = []
    errors: list[ParseError] = []

    if field_delimiter is not None:
        counts = [_field_count(ln, field_delimiter) for ln in decoded if ln]
        mode = _mode(counts) if counts else 0
        for idx, (raw, line) in enumerate(zip(raw_lines, decoded, strict=True), start=1):
            if not line:
                continue
            parts = _split_delimited(line, field_delimiter)
            if parts is None:
                errors.append(ParseError(idx, "unterminated quoted field"))
            elif abs(len(parts) - mode) > mode:
                errors.append(ParseError(idx, f"expected about {mode} fields, found {len(parts)}"))
            else:
                records.append(Record(idx, parts, len(raw)))
        has_header = hints.has_header if hints is not None else _detect_header([r.fields for r in records])
    else:
        minimum = boundaries[1] if len(boundaries) > 1 else 0
        for idx, raw in enumerate(raw_lines, start=1):
            if len(raw) == 0:
                continue
            if len(raw) < minimum:
                errors.append(ParseError(idx, f"record shorter than first column boundary ({minimum})"))
                continue
            records.append(Record(idx, _fixed_fields(raw, boundaries), len(raw)))
        has_header = hints.has_header if hints is not None else None

    layout = Layout(
        line_delimiter,
        record_length if line_delimiter == "FIXED" else None,
        encoding,
        field_delimiter,
        has_header,
        boundaries if field_delimiter is None else [],
    )
    return ParseResult(layout, confidence, uncertain, records, errors, records[:PREVIEW_SIZE])


def _quote(value: str, delimiter: str) -> str:
    if delimiter in value or '"' in value:
        return '"' + value.replace('"', '""') + '"'
    return value


def print_records(records: list[list[str]], layout: Layout) -> bytes:
    codec = _codec(layout.encoding)
    space = " ".encode(codec)
    out: list[bytes] = []
    for rec in records:
        if layout.field_delimiter is not None:
            line = layout.field_delimiter.join(_quote(v, layout.field_delimiter) for v in rec)
            encoded = line.encode(codec)
        else:
            bounds = layout.column_boundaries or [0]
            pieces: list[bytes] = []
            for i, value in enumerate(rec):
                enc = value.encode(codec)
                if i < len(bounds) - 1:
                    width = bounds[i + 1] - bounds[i]
                    if len(enc) > width:
                        raise ValueError(f"value wider than column {i}")
                    enc += space * (width - len(enc))
                elif i == len(bounds) - 1 and layout.line_delimiter == "FIXED" and layout.record_length:
                    width = layout.record_length - bounds[i]
                    if len(enc) > width:
                        raise ValueError(f"value wider than column {i}")
                    enc += space * (width - len(enc))
                pieces.append(enc)
            encoded = b"".join(pieces)
        out.append(encoded + (b"" if layout.line_delimiter == "FIXED" else _terminator_bytes(layout)))
    return b"".join(out)

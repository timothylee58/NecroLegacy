from __future__ import annotations

import re
from dataclasses import dataclass, field

MAX_NAME = 30
OCCURS_MIN, OCCURS_MAX = 1, 9999
VALID_LEVELS = frozenset([*range(1, 50), 66, 77, 88])
MAX_PIC_REPEAT = 100_000

_USAGE_ALIASES = {
    "DISPLAY": "DISPLAY",
    "COMP": "COMP",
    "COMPUTATIONAL": "COMP",
    "BINARY": "BINARY",
    "COMP-5": "COMP-5",
    "COMPUTATIONAL-5": "COMP-5",
    "COMP-3": "COMP-3",
    "COMPUTATIONAL-3": "COMP-3",
    "PACKED-DECIMAL": "PACKED-DECIMAL",
    "COMP-1": "COMP-1",
    "COMPUTATIONAL-1": "COMP-1",
    "COMP-2": "COMP-2",
    "COMPUTATIONAL-2": "COMP-2",
}
_BINARY_USAGES = frozenset(["COMP", "BINARY", "COMP-5"])
_PACKED_USAGES = frozenset(["COMP-3", "PACKED-DECIMAL"])
_FLOAT_BYTES = {"COMP-1": 4, "COMP-2": 8}
_RESERVED = frozenset(
    [
        "PIC", "PICTURE", "USAGE", "IS", "OCCURS", "TIMES", "REDEFINES", "VALUE", "VALUES", "RENAMES",
        "SYNC", "SYNCHRONIZED", "JUSTIFIED", "JUST", "SIGN", "DEPENDING", "COPY", "EXEC", *_USAGE_ALIASES,
    ]
)  # fmt: skip
_NAME_RE = re.compile(r"^[A-Za-z0-9]+(-[A-Za-z0-9]+)*$")
_PIC_COUNT_RE = re.compile(r"\((\d+)\)")
_LEVEL_FIXED_OK = " *-/"


class CopybookError(Exception):
    def __init__(self, line: int, text: str, reason: str = "unsupported construct") -> None:
        super().__init__(f"line {line}: {reason}: {text!r}" if text else f"line {line}: {reason}")
        self.line = line
        self.text = text
        self.reason = reason

    @property
    def code(self) -> str:
        return "copybook_no_layout" if self.reason == "no layout found" else "copybook_error"


@dataclass(frozen=True)
class CopybookField:
    level: int
    name: str
    pic: str | None
    usage: str | None
    occurs: int | None
    redefines: str | None
    value: str | None
    offset: int
    length: int
    is_group: bool


@dataclass(frozen=True)
class RecordLayout:
    name: str
    record_length: int
    fields: list[CopybookField] = field(default_factory=list)


@dataclass(frozen=True)
class _Token:
    text: str
    line: int
    is_str: bool = False

    @property
    def word(self) -> str:
        return self.text.upper()


def _looks_fixed(lines: list[str]) -> bool:
    seen = False
    for line in lines:
        if not line.strip():
            continue
        seen = True
        if len(line) < 7:
            return False
        area = line[:6]
        if not (area.strip() == "" or (area.isdigit() and len(area) == 6)):
            return False
        if line[6] not in _LEVEL_FIXED_OK:
            return False
    return seen


def _content_lines(text: str) -> list[tuple[int, str]]:
    lines = re.split(r"\r\n|\r|\n", text)
    fixed = _looks_fixed(lines)
    out: list[tuple[int, str]] = []
    for number, line in enumerate(lines, start=1):
        if not line.strip():
            continue
        if fixed:
            if line[6] in "*/":
                continue
            if line[6] == "-":
                raise CopybookError(number, line.strip(), "continuation lines are not supported")
            out.append((number, line[7:72]))
        elif not line.lstrip().startswith("*"):
            out.append((number, line))
    return out


def _tokenize(text: str) -> list[_Token | None]:
    """A None entry is a statement-terminating period."""
    tokens: list[_Token | None] = []
    for number, line in _content_lines(text):
        i, n = 0, len(line)
        while i < n:
            c = line[i]
            if c.isspace():
                i += 1
            elif line.startswith("*>", i):
                break
            elif c in "'\"":
                j = i + 1
                while True:
                    j = line.find(c, j)
                    if j < 0:
                        raise CopybookError(number, line[i:].strip(), "unterminated literal")
                    if line[j + 1 : j + 2] == c:
                        j += 2
                        continue
                    break
                tokens.append(_Token(line[i : j + 1], number, True))
                i = j + 1
            elif c in ",;" and (i + 1 == n or line[i + 1].isspace()):
                i += 1
            else:
                j = i
                while j < n and not line[j].isspace():
                    j += 1
                word = line[i:j]
                i = j
                ends = word.endswith(".")
                if ends:
                    word = word[:-1]
                word = word.rstrip(",;")
                if word:
                    tokens.append(_Token(word, number))
                if ends:
                    tokens.append(None)
    return tokens


@dataclass
class _Raw:
    level: int
    name: str
    line: int
    level_text: str
    pic: str | None = None
    pic_kind: tuple[bool, int] | None = None  # (numeric, digits)
    pic_size: int = 0
    pic_token: _Token | None = None
    usage: str | None = None
    usage_token: _Token | None = None
    occurs: int | None = None
    occurs_token: _Token | None = None
    redefines: str | None = None
    redefines_token: _Token | None = None
    value: str | None = None


@dataclass
class _Node:
    raw: _Raw
    children: list[_Node] = field(default_factory=list)
    conditions: list[_Node] = field(default_factory=list)
    offset: int = 0
    length: int = 0
    is_group: bool = False


def _parse_pic(token: _Token) -> tuple[str, bool, int, int]:
    """Returns canonical PIC, numeric flag, digit count and DISPLAY size."""
    pic = token.word
    bad = CopybookError(token.line, token.text)
    parts: list[tuple[str, int]] = []
    i, n = 0, len(pic)
    while i < n:
        ch = pic[i]
        if ch not in "SXA9V":
            raise bad
        if ch == "S" and i != 0:
            raise bad
        count = 1
        i += 1
        match = _PIC_COUNT_RE.match(pic, i)
        if match:
            if ch in "SV":
                raise bad
            count = int(match.group(1))
            if not 1 <= count <= MAX_PIC_REPEAT:
                raise bad
            i = match.end()
        if parts and parts[-1][0] == ch and ch in "XA9":
            parts[-1] = (ch, parts[-1][1] + count)
        else:
            parts.append((ch, count))
    chars = [p[0] for p in parts]
    if chars.count("V") > 1 or not set(chars) & set("XA9"):
        raise bad
    numeric = set(chars) <= set("S9V")
    if not numeric and set(chars) & set("SV"):
        raise bad
    canonical = "".join(ch if count == 1 or ch in "SV" else f"{ch}({count})" for ch, count in parts)
    digits = sum(c for ch, c in parts if ch == "9")
    size = sum(c for ch, c in parts if ch in "XA9")
    return canonical, numeric, digits, size


def _check_name(token: _Token) -> str:
    text = token.text
    if token.is_str or len(text) > MAX_NAME or not _NAME_RE.match(text) or not any(c.isalpha() for c in text):
        raise CopybookError(token.line, text)
    if text.upper() in _RESERVED:
        raise CopybookError(token.line, text)
    return text.upper()


def _parse_statement(tokens: list[_Token]) -> _Raw:
    first = tokens[0]
    if first.is_str or not first.text.isdigit() or len(first.text) > 2 or int(first.text) not in VALID_LEVELS:
        raise CopybookError(first.line, first.text)
    level = int(first.text)
    if len(tokens) < 2:
        raise CopybookError(first.line, first.text, "missing field name")
    raw = _Raw(level, _check_name(tokens[1]), first.line, first.text)
    rest = tokens[2:]
    if level in (66, 88):
        return _parse_condition(raw, rest, first)
    i = 0
    seen: set[str] = set()
    while i < len(rest):
        tok = rest[i]
        word = tok.word if not tok.is_str else ""
        i += 1
        if word in _USAGE_ALIASES:
            clause = "USAGE"
        elif word in ("PIC", "PICTURE"):
            clause = "PIC"
        elif word in ("USAGE", "OCCURS", "REDEFINES"):
            clause = word
        else:
            raise CopybookError(tok.line, tok.text)
        if clause in seen:
            raise CopybookError(tok.line, tok.text)
        seen.add(clause)
        if clause == "PIC":
            if i < len(rest) and rest[i].word == "IS":
                i += 1
            if i >= len(rest):
                raise CopybookError(tok.line, tok.text)
            raw.pic_token = rest[i]
            raw.pic, numeric, digits, raw.pic_size = _parse_pic(rest[i])
            raw.pic_kind = (numeric, digits)
            i += 1
        elif clause == "USAGE":
            if word == "USAGE":
                if i < len(rest) and rest[i].word == "IS":
                    i += 1
                if i >= len(rest) or rest[i].word not in _USAGE_ALIASES:
                    raise CopybookError(
                        rest[i].line if i < len(rest) else tok.line, rest[i].text if i < len(rest) else tok.text
                    )
                raw.usage_token = rest[i]
                raw.usage = _USAGE_ALIASES[rest[i].word]
                i += 1
            else:
                raw.usage_token = tok
                raw.usage = _USAGE_ALIASES[word]
        elif clause == "OCCURS":
            if i >= len(rest) or not rest[i].text.isdigit() or rest[i].is_str:
                raise CopybookError(
                    rest[i].line if i < len(rest) else tok.line, rest[i].text if i < len(rest) else tok.text
                )
            count = int(rest[i].text)
            if not OCCURS_MIN <= count <= OCCURS_MAX:
                raise CopybookError(rest[i].line, rest[i].text)
            raw.occurs, raw.occurs_token = count, tok
            i += 1
            if i < len(rest) and rest[i].word == "TIMES":
                i += 1
        else:
            if i >= len(rest):
                raise CopybookError(tok.line, tok.text)
            raw.redefines = _check_name(rest[i])
            raw.redefines_token = rest[i]
            i += 1
    return raw


def _parse_condition(raw: _Raw, rest: list[_Token], first: _Token) -> _Raw:
    keywords = ("RENAMES",) if raw.level == 66 else ("VALUE", "VALUES")
    if not rest:
        raise CopybookError(first.line, first.text, "missing clause")
    if rest[0].is_str or rest[0].word not in keywords:
        raise CopybookError(rest[0].line, rest[0].text)
    body = rest[1:]
    if body and not body[0].is_str and body[0].word in ("IS", "ARE"):
        body = body[1:]
    if not body:
        raise CopybookError(rest[0].line, rest[0].text)
    raw.value = " ".join(t.text for t in body)
    return raw


def _build_records(raws: list[_Raw]) -> list[_Node]:
    records: list[_Node] = []
    stack: list[_Node] = []
    last: _Node | None = None
    for raw in raws:
        node = _Node(raw)
        if raw.level in (1, 77):
            stack = [node]
            records.append(node)
        elif raw.level in (66, 88):
            if last is None:
                raise CopybookError(raw.line, raw.level_text, "condition without a data item")
            last.conditions.append(node)
            continue
        else:
            if not stack or stack[0].raw.level == 77:
                raise CopybookError(raw.line, raw.level_text, "item outside a 01 record")
            while stack[-1].raw.level >= raw.level:
                stack.pop()
            stack[-1].children.append(node)
            stack.append(node)
        last = node
    return records


def _elementary_length(raw: _Raw) -> int:
    usage = raw.usage
    if raw.pic is None:
        if usage in _FLOAT_BYTES:
            return _FLOAT_BYTES[usage]
        token = raw.usage_token
        raise CopybookError(raw.line, token.text if token else raw.level_text, "item without PIC")
    assert raw.pic_kind is not None and raw.pic_token is not None
    numeric, digits = raw.pic_kind
    if usage in _FLOAT_BYTES:
        assert raw.usage_token is not None
        raise CopybookError(raw.usage_token.line, raw.usage_token.text, "PIC not allowed with floating point")
    if usage in (None, "DISPLAY"):
        return raw.pic_size
    if not numeric or not 1 <= digits <= 18:
        raise CopybookError(raw.pic_token.line, raw.pic_token.text, "PIC not valid for this USAGE")
    if usage in _PACKED_USAGES:
        return (digits + 2) // 2
    return 2 if digits <= 4 else 4 if digits <= 9 else 8


def _measure(node: _Node) -> None:
    raw = node.raw
    if node.children:
        if raw.pic is not None or raw.usage is not None:
            first_child = node.children[0].raw
            raise CopybookError(first_child.line, first_child.level_text, "elementary item with subordinate items")
        node.is_group = True
        seen: dict[str, _Node] = {}
        total = 0
        for child in node.children:
            _measure(child)
            target_name = child.raw.redefines
            if target_name is None:
                total += child.length
            else:
                target = seen.get(target_name)
                if target is None or target.raw.level != child.raw.level:
                    token = child.raw.redefines_token
                    assert token is not None
                    raise CopybookError(token.line, token.text, "REDEFINES target not found")
            seen[child.raw.name] = child
        node.length = total * (raw.occurs or 1)
    else:
        if raw.pic is None and raw.usage not in _FLOAT_BYTES:
            raise CopybookError(raw.line, raw.name, "group item without subordinate items")
        node.length = _elementary_length(raw) * (raw.occurs or 1)


def _place(node: _Node) -> None:
    running = node.offset
    placed: dict[str, _Node] = {}
    for child in node.children:
        target = placed.get(child.raw.redefines) if child.raw.redefines else None
        if target is not None:
            child.offset = target.offset
        else:
            child.offset = running
            running += child.length
        placed[child.raw.name] = child
        _place(child)


def _flatten(node: _Node, out: list[CopybookField]) -> None:
    raw = node.raw
    out.append(
        CopybookField(
            raw.level,
            raw.name,
            raw.pic,
            raw.usage,
            raw.occurs,
            raw.redefines,
            None,
            node.offset,
            node.length,
            node.is_group,
        )
    )
    for cond in node.conditions:
        c = cond.raw
        out.append(CopybookField(c.level, c.name, None, None, None, None, c.value, node.offset, 0, False))
    for child in node.children:
        _flatten(child, out)


def parse_copybook(text: str) -> list[RecordLayout]:
    tokens = _tokenize(text)
    statements: list[list[_Token]] = []
    current: list[_Token] = []
    for tok in tokens:
        if tok is None:
            if current:
                statements.append(current)
                current = []
        else:
            current.append(tok)
    if current:
        raise CopybookError(current[0].line, current[0].text, "missing period")
    raws = [_parse_statement(s) for s in statements]
    if not raws:
        raise CopybookError(1, "", "no layout found")
    records = _build_records(raws)
    layouts: list[RecordLayout] = []
    for root in records:
        _measure_root(root)
        fields: list[CopybookField] = []
        _flatten(root, fields)
        layouts.append(RecordLayout(root.raw.name, root.length, fields))
    return layouts


def _measure_root(root: _Node) -> None:
    if root.raw.occurs is not None or root.raw.redefines is not None:
        token = root.raw.occurs_token or root.raw.redefines_token
        assert token is not None
        raise CopybookError(token.line, token.text, "not allowed on a 01 or 77 item")
    _measure(root)
    _place(root)


def print_copybook(layouts: list[RecordLayout]) -> str:
    lines: list[str] = []
    for layout in layouts:
        for f in layout.fields:
            parts = [f"{f.level:02d}", f.name]
            if f.level == 88:
                parts.append(f"VALUE {f.value}")
            elif f.level == 66:
                parts.append(f"RENAMES {f.value}")
            else:
                if f.redefines:
                    parts.append(f"REDEFINES {f.redefines}")
                if f.pic:
                    parts.append(f"PIC {f.pic}")
                if f.usage:
                    parts.append(f"USAGE {f.usage}")
                if f.occurs:
                    parts.append(f"OCCURS {f.occurs} TIMES")
            lines.append(" ".join(parts) + ".")
    return "\n".join(lines) + "\n"

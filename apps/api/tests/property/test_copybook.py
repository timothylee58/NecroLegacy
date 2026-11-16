import pytest
from hypothesis import given
from hypothesis import strategies as st

from app.services.copybook import CopybookError, parse_copybook, print_copybook

_names = st.from_regex(r"[A-Z][A-Z0-9]{0,6}(-[A-Z0-9]{1,4}){0,2}", fullmatch=True).filter(
    lambda n: n not in {"PIC", "IS", "COMP", "VALUE", "SYNC", "SIGN", "COPY", "EXEC", "JUST", "TIMES", "USAGE"}
)


@st.composite
def elementary(draw):
    kind = draw(st.sampled_from(["x", "9", "s9v", "comp", "comp3", "comp5", "comp1", "comp2"]))
    n = draw(st.integers(1, 18))
    d = draw(st.integers(0, 8))
    if kind == "x":
        return f"PIC X({n})" if n > 1 else "PIC X", n
    if kind == "9":
        return f"PIC {'9' * n}", n
    if kind == "s9v":
        return f"PIC S9({n})V{'9' * d}" if d else f"PIC S9({n})", n + d
    if kind in ("comp", "comp5"):
        word = "COMP" if kind == "comp" else "COMP-5"
        size = 2 if n <= 4 else 4 if n <= 9 else 8
        return f"PIC S9({n}) {word}", size
    if kind == "comp3":
        return f"PIC S9({n}) COMP-3", (n + 2) // 2
    return ("COMP-1", 4) if kind == "comp1" else ("COMP-2", 8)


@st.composite
def copybooks(draw):
    """Returns (text, expected record length, expected redefines pairs)."""
    lines: list[str] = []
    total = 0
    top: list[str] = []
    n_items = draw(st.integers(1, 6))
    names = draw(st.lists(_names, min_size=n_items * 4 + 2, max_size=n_items * 4 + 2, unique=True))
    it = iter(names)
    record = next(it)
    lines.append(f"01 {record}.")
    last_elem: tuple[str, int] | None = None
    for _ in range(n_items):
        if draw(st.booleans()):
            gname = next(it)
            occurs = draw(st.integers(1, 5))
            inner = draw(st.lists(elementary(), min_size=1, max_size=3))
            lines.append(f"05 {gname} OCCURS {occurs} TIMES.")
            glen = 0
            for clause, size in inner:
                lines.append(f"10 {next(it)} {clause}.")
                glen += size
            total += glen * occurs
            last_elem = None
        else:
            clause, size = draw(elementary())
            name = next(it)
            lines.append(f"05 {name} {clause}.")
            total += size
            last_elem = (name, size)
            top.append(name)
            if draw(st.booleans()):
                lines.append(f"88 {next(it)} VALUE 'A' 'B'.")
    if last_elem is not None and draw(st.booleans()):
        lines.append(f"05 {next(it)} REDEFINES {last_elem[0]} PIC X(3).")
    return "\n".join(lines) + "\n", total, last_elem


@given(copybooks(), st.sampled_from(["free", "fixed"]))
def test_copybook_round_trip(case, style):
    text, expected_total, _ = case
    if style == "fixed":
        text = "".join("       " + line + "\n" for line in text.splitlines())
    layouts = parse_copybook(text)
    assert layouts[0].record_length == expected_total
    assert parse_copybook(print_copybook(layouts)) == layouts
    for layout in layouts:
        by_name = {f.name: f for f in layout.fields}
        for f in layout.fields:
            if f.redefines:
                assert f.offset == by_name[f.redefines].offset
        top = [f for f in layout.fields if f.level == 5 and not f.redefines]
        assert layout.record_length == sum(f.length for f in top)
        assert layout.fields[0].length == layout.record_length


def test_offsets_and_sizes():
    text = """
    01 REC.
       05 ID PIC 9(5).
       05 PRICE PIC S9(7)V99 COMP-3.
       05 QTY PIC S9(4) COMP.
       05 ALT REDEFINES QTY PIC XX.
       05 LINES OCCURS 3 TIMES.
          10 SKU PIC X(4).
          10 N PIC 9(9) BINARY.
    """
    (layout,) = parse_copybook(text)
    got = {f.name: (f.offset, f.length) for f in layout.fields}
    assert got["ID"] == (0, 5)
    assert got["PRICE"] == (5, 5)
    assert got["QTY"] == (10, 2)
    assert got["ALT"] == (10, 2)
    assert got["LINES"] == (12, 24)
    assert got["N"] == (16, 4)
    assert layout.record_length == 36


def test_fixed_format_comments_and_sequence_numbers():
    text = (
        "000100 01 REC.                                                            SEQ00001\n"
        "      * a comment line\n"
        "000200    05 A PIC X(2).                                                   SEQ00002\n"
    )
    (layout,) = parse_copybook(text)
    assert layout.record_length == 2


def test_level_77_is_its_own_record():
    layouts = parse_copybook("77 A PIC X(3).\n77 B PIC 9(2).\n")
    assert [(layout.name, layout.record_length) for layout in layouts] == [("A", 3), ("B", 2)]


UNSUPPORTED = [
    ("05 A PIC X OCCURS 3 DEPENDING ON N.", "DEPENDING"),
    ("05 A PIC S9 SIGN IS LEADING SEPARATE.", "SIGN"),
    ("05 A PIC 9 SYNC.", "SYNC"),
    ("05 A PIC X JUSTIFIED RIGHT.", "JUSTIFIED"),
    ("05 A PIC ZZ9.", "ZZ9"),
    ("05 A PIC 9.99.", "9.99"),
    ("05 A PIC $99.", "$99"),
    ("05 A PIC X(3)B.", "X(3)B"),
    ("COPY OTHER.", "COPY"),
    ("EXEC SQL END-EXEC.", "EXEC"),
    ("50 A PIC X.", "50"),
    ("00 A PIC X.", "00"),
    (f"05 {'N' * 31} PIC X.", "N" * 31),
    ("05 A PIC X OCCURS 0 TIMES.", "0"),
    ("05 A PIC X OCCURS 10000 TIMES.", "10000"),
    ("05 A PIC X FROBNICATE.", "FROBNICATE"),
    ("05 A PIC X REDEFINES MISSING.", "MISSING"),
    ("05 A PIC X COMP-3.", "X"),
]


@given(
    st.sampled_from(UNSUPPORTED),
    st.integers(0, 3),
    st.integers(0, 3),
)
def test_unsupported_construct_is_atomic(case, before, after):
    bad, construct = case
    head = ["01 REC."] + [f"05 F{i} PIC X(2)." for i in range(before)]
    lines = head + [bad] + [f"05 G{i} PIC X(2)." for i in range(after)]
    text = "\n".join(lines) + "\n"
    with pytest.raises(CopybookError) as info:
        parse_copybook(text)
    assert info.value.line == len(head) + 1
    assert info.value.text == construct


@given(st.sampled_from(["", "\n\n", "   \n", "      * only a comment\n", "* free comment\n"]))
def test_empty_input_reports_no_layout(text):
    with pytest.raises(CopybookError) as info:
        parse_copybook(text)
    assert info.value.line == 1
    assert info.value.text == ""
    assert info.value.code == "copybook_no_layout"


def test_group_without_children_and_missing_period_fail():
    with pytest.raises(CopybookError):
        parse_copybook("01 REC.\n05 G.\n")
    with pytest.raises(CopybookError) as info:
        parse_copybook("01 REC.\n05 A PIC X\n")
    assert info.value.line == 2

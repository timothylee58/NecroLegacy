from hypothesis import given, settings
from hypothesis import strategies as st

from app.services.parser import Layout, parse, print_records

ENCODINGS = ["ascii", "utf-8", "ebcdic"]
TERMINATORS = ["LF", "CRLF", "CR", "FIXED"]
DELIMS = [",", ";", "\t", "|"]

_ascii = st.characters(min_codepoint=33, max_codepoint=126)
_utf8 = st.characters(min_codepoint=33, max_codepoint=0x24F, blacklist_categories=("Cs", "Cc", "Zs", "Zl", "Zp"))


def _value(alphabet: st.SearchStrategy[str], max_size: int, min_size: int = 0) -> st.SearchStrategy[str]:
    inner = st.text(alphabet=st.one_of(alphabet, st.just(" ")), min_size=min_size, max_size=max_size)
    return inner.map(str.rstrip)


@st.composite
def layout_and_records(draw):
    encoding = draw(st.sampled_from(ENCODINGS))
    alphabet = _utf8 if encoding == "utf-8" else _ascii
    terminator = draw(st.sampled_from(TERMINATORS))
    n_fields = draw(st.integers(1, 6))
    count = draw(st.integers(1, 30))
    delimited = terminator != "FIXED" and draw(st.booleans())
    first = _value(alphabet, 12, 1).filter(bool)
    if delimited:
        delim = draw(st.sampled_from(DELIMS))
        layout = Layout(terminator, None, encoding, delim, None, [])
        rest = _value(alphabet, 12)
        row = st.tuples(first, *[rest] * (n_fields - 1)).map(list)
        return layout, draw(st.lists(row, min_size=count, max_size=count))
    widths = draw(st.lists(st.integers(1, 4), min_size=n_fields, max_size=n_fields))
    # Widths are in bytes; UTF-8 characters take up to 2 bytes, so each column is 3x the drawn width.
    widths_bytes = [w * 3 for w in widths]
    bounds = [0]
    for w in widths_bytes[:-1]:
        bounds.append(bounds[-1] + w)
    record_length = bounds[-1] + widths_bytes[-1] if terminator == "FIXED" else None
    layout = Layout(terminator, record_length, encoding, None, None, bounds)

    def fits(w: int):
        return _value(alphabet, w, 0).filter(lambda v: len(v.encode("utf-8")) <= w)

    row = st.tuples(fits(widths_bytes[0]).filter(bool), *[fits(w) for w in widths_bytes[1:]]).map(list)
    return layout, draw(st.lists(row, min_size=count, max_size=count))


@settings(max_examples=150, deadline=None)
@given(layout_and_records())
def test_legacy_record_round_trip(case):
    layout, recs = case
    data = print_records(recs, layout)
    result = parse(data, hints=layout)
    assert result.errors == []
    assert result.records_as_lists() == recs


@settings(max_examples=150, deadline=None)
@given(st.binary(max_size=3000))
def test_parser_determinism_and_bounds_on_arbitrary_bytes(data):
    a, b = parse(data), parse(data)
    assert a == b
    assert 0.0 <= a.encoding_confidence <= 1.0
    bounds = a.layout.column_boundaries
    assert len(bounds) <= 100
    assert all(x < y for x, y in zip(bounds, bounds[1:], strict=False))
    assert len(a.preview) == min(50, len(a.records))
    assert a.preview == a.records[:50]


@settings(max_examples=60, deadline=None)
@given(st.integers(0, 14), st.integers(12, 70))
def test_failed_record_is_excluded_and_reported(position, good):
    lines = [f"a{i},b{i},c{i}" for i in range(good)]
    index = position % (good + 1)
    lines.insert(index, 'x,"unterminated,z')
    data = ("\n".join(lines) + "\n").encode()
    layout = Layout("LF", None, "ascii", ",", None, [])
    result = parse(data, hints=layout)
    bad_line = index + 1
    assert [e.line for e in result.errors] == [bad_line]
    assert len(result.records) == good
    assert all(r.row_number != bad_line for r in result.records)
    detected = parse(data)
    assert detected.layout.field_delimiter == ","
    assert [e.line for e in detected.errors] == [bad_line]


def test_ebcdic_detection_and_decode():
    text = "CUST0001 WIDGET 00100\nCUST0002 GADGET 00200\n"
    result = parse(text.encode("cp037"))
    assert result.layout.encoding == "ebcdic"
    assert result.layout.line_delimiter == "LF"
    assert result.records[0].fields[0].startswith("CUST0001")


def test_uncertain_encoding_flag():
    data = bytes([0x80, 0x81, 0xFF, 0xFE, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46])
    result = parse(data)
    assert result.layout.encoding == "utf-8"
    assert result.encoding_uncertain is True


def test_multi_record_batch_detects_the_shared_delimiter():
    # Header, stock and sale lines carry 4, 5 and 6 fields: no single count reaches 90% of lines.
    lines = ["BR|branch_code|branch_name|zone"] + [f"BR|N00{i}|Warehouse N00{i}|DRY" for i in range(5)]
    lines += ["ST|stock_id|sku_code|branch_code|qty"] + [f"ST|{i:05d}|SKU{i}|N001|{i}" for i in range(10)]
    lines += ["SL|sale_id|sku_code|branch_code|sale_date|qty"] + [f"SL|{i:06d}|SKU1|N001|19940101|2" for i in range(40)]
    result = parse(("\n".join(lines) + "\n").encode())
    assert result.layout.field_delimiter == "|"
    assert result.preview[1].fields == ["BR", "N000", "Warehouse N000", "DRY"]


def test_prose_with_commas_is_not_treated_as_delimited():
    # Every line has commas, so only the record-type guard (a distinct first field per line) rejects it.
    lines = [f"Entry {i} was posted late, then reversed{', twice' * (i % 3)}, by clerk {i % 7}." for i in range(60)]
    assert parse(("\n".join(lines) + "\n").encode()).layout.field_delimiter is None

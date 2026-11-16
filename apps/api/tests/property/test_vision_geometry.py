from hypothesis import given, settings
from hypothesis import strategies as st

from app.services.vision import analyze
from tests.vision_helpers import StubEngine, skewed_table_png

confidences = st.lists(st.sampled_from([0.0, 0.59, 0.6, 0.61, 0.95, 1.0, 0.5949, 0.605]), min_size=1, max_size=7)


@settings(max_examples=25, deadline=None)
@given(angle=st.integers(-450, 450).map(lambda n: n / 10), confs=confidences)
def test_vision_geometry(angle: float, confs: list[float]) -> None:
    # Feature: digital-autopsy-engine, Property 16: Vision geometry
    engine = StubEngine(confidences=confs)
    result = analyze(skewed_table_png(angle), "tesseract", {"tesseract": engine, "paddleocr": engine})
    assert result.needs_fallback in (None, "low_confidence")
    assert result.cells
    assert -45.0 <= result.skew_angle_degrees <= 45.0
    for cell in result.cells:
        b = cell.bbox
        assert b.width >= 1 and b.height >= 1
        assert b.x >= 0 and b.y >= 0
        assert b.x + b.width <= result.image_width and b.y + b.height <= result.image_height
        assert cell.smudged == (cell.confidence < 0.6)
    for d in result.defects:
        assert d.bbox.x + d.bbox.width <= result.image_width and d.bbox.y + d.bbox.height <= result.image_height
    assert min(c.row for c in result.cells) == 1
    assert sorted({c.row for c in result.cells}) == list(range(1, max(c.row for c in result.cells) + 1))
    rows = {}
    for c in result.cells:
        rows.setdefault(c.row, []).append(c)
    ordered = sorted(rows)
    tops = [sum(c.bbox.y + c.bbox.height / 2 for c in rows[r]) / len(rows[r]) for r in ordered]
    if abs(angle) < 1:
        assert tops == sorted(tops)
    for r in ordered:
        xs = [c.bbox.x + c.bbox.width / 2 for c in rows[r]]
        if abs(angle) < 1:
            assert xs == sorted(xs)
        assert [c.col for c in rows[r]] == sorted(c.col for c in rows[r])

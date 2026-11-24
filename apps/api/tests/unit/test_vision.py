import logging

import cv2
import numpy as np
import pytest

from app.services.vision import (
    BoundingBox,
    DefectInput,
    VisionError,
    analyze,
    check_dimensions,
    find_defects,
    resolve_engine_name,
)
from tests.vision_helpers import BrokenEngine, StubEngine, skewed_table_png


def png(w: int, h: int) -> bytes:
    return cv2.imencode(".png", np.full((h, w), 255, np.uint8))[1].tobytes()


@pytest.mark.parametrize("w,h", [(199, 400), (400, 199), (8001, 5000)])
def test_dimension_limits_rejected(w: int, h: int) -> None:
    with pytest.raises(VisionError) as e:
        check_dimensions(w, h)
    assert e.value.code == "unreadable_image"


def test_undecodable_and_tiny_images() -> None:
    with pytest.raises(VisionError) as e:
        analyze(b"not an image")
    assert e.value.code == "unreadable_image"
    with pytest.raises(VisionError):
        analyze(png(150, 400))


def test_blank_image_requests_fallback() -> None:
    assert analyze(png(400, 400), "tesseract", {}).needs_fallback == "no_grid"


def test_skew_recorded_to_one_decimal() -> None:
    engine = StubEngine()
    r = analyze(skewed_table_png(12.0), "tesseract", {"tesseract": engine})
    assert round(r.skew_angle_degrees, 1) == r.skew_angle_degrees
    assert abs(abs(r.skew_angle_degrees) - 12.0) < 1.5
    assert len(r.cells) >= 18


def test_engine_failover_and_total_failure() -> None:
    good = StubEngine("tesseract")
    r = analyze(skewed_table_png(0), "paddleocr", {"paddleocr": BrokenEngine("paddleocr"), "tesseract": good})
    assert r.engine == "tesseract" and len(r.cells) == 20
    r = analyze(
        skewed_table_png(0),
        "paddleocr",
        {"paddleocr": BrokenEngine("paddleocr"), "tesseract": BrokenEngine("tesseract")},
    )
    assert r.needs_fallback == "ocr_failed" and not r.cells


def test_low_mean_confidence_requests_fallback() -> None:
    r = analyze(skewed_table_png(0), "tesseract", {"tesseract": StubEngine(confidences=[0.1])})
    assert r.needs_fallback == "low_confidence"
    assert all(c.smudged for c in r.cells)


def test_confidence_boundary_and_rounding() -> None:
    r = analyze(skewed_table_png(0), "tesseract", {"tesseract": StubEngine(confidences=[0.6, 0.5949, 0.9])})
    by_conf = {c.confidence: c.smudged for c in r.cells}
    assert by_conf[0.6] is False and by_conf[0.59] is True


def test_cell_limit_checked_before_ocr(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.services.vision.MAX_CELLS", 10)
    engine = StubEngine()
    with pytest.raises(VisionError) as e:
        analyze(skewed_table_png(0), "tesseract", {"tesseract": engine})
    assert e.value.code == "cell_limit_exceeded" and engine.calls == 0


def test_invalid_engine_warns(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.WARNING, logger="necro.vision"):
        assert resolve_engine_name("bogus") == "paddleocr"
    assert "bogus" in caplog.text
    assert resolve_engine_name("tesseract") == "tesseract"


def item(
    row: int, col: int, text: str, conf: float = 0.9, cx: float = 50, w: float = 100, open_side: bool = False
) -> DefectInput:
    return DefectInput(row, col, text, conf, conf < 0.6, cx, w, open_side, BoundingBox(x=0, y=0, width=10, height=10))


def test_defect_rules() -> None:
    items = [
        item(1, 1, "ITEM"),
        item(1, 2, "TOTAL"),
        item(2, 1, "1", conf=0.4),
        item(2, 2, "12.5"),
        item(3, 1, "x", conf=0.4),
        item(3, 2, "abc"),
        item(4, 1, "7", cx=50),
        item(4, 2, "9.00", open_side=True),
        item(5, 1, "9", cx=50),
        item(5, 2, "9.00", cx=200),
    ]
    kinds = {(d.type, d.row, d.col): d.confidence for d in find_defects(items)}
    assert kinds[("smudged_digit", 2, 1)] == 0.6
    assert ("smudged_digit", 3, 1) not in kinds
    assert kinds[("torn_total", 3, 2)] == 0.9
    assert kinds[("torn_total", 4, 2)] == 0.7
    assert ("torn_total", 1, 2) not in kinds
    assert kinds[("misaligned_column", 5, 2)] == 1.0
    assert ("misaligned_column", 4, 1) not in kinds


def test_misalignment_threshold_is_exclusive() -> None:
    cells = [item(1, 1, "a", cx=100), item(2, 1, "1", cx=100), item(3, 1, "2", cx=100), item(4, 1, "3", cx=125)]
    assert not [d for d in find_defects(cells) if d.type == "misaligned_column"]
    cells[-1] = item(4, 1, "3", cx=125.5)
    assert [d for d in find_defects(cells) if d.type == "misaligned_column"]


class SizeEngine:
    """Reads small crops well and full-size ones badly, like dot-matrix print; widths identify each pass."""

    name = "tesseract"

    def __init__(self, fail_small: bool = False) -> None:
        self.widths: list[int] = []
        self.fail_small = fail_small

    def read(self, crop: np.ndarray) -> tuple[str, float]:
        w = crop.shape[1]
        self.widths.append(w)
        if w >= 90:
            return "garbled", 0.2
        if self.fail_small:
            raise RuntimeError("engine down")
        return ("12.5", 0.9) if w >= 50 else ("12", 0.6)


def test_low_confidence_reads_are_rescued_at_smaller_scales() -> None:
    engine = SizeEngine()
    r = analyze(skewed_table_png(0), "tesseract", {"tesseract": engine})
    assert {c.text for c in r.cells} == {"12.5"} and r.needs_fallback is None
    # Each cell keeps its most confident read, not the last one.
    assert all(c.confidence == 0.9 for c in r.cells)
    assert len(engine.widths) == 3 * len(r.cells)


def test_boxes_are_unchanged_by_the_rescue_pass() -> None:
    plain = analyze(skewed_table_png(0), "tesseract", {"tesseract": StubEngine(confidences=[0.9])})
    rescued = analyze(skewed_table_png(0), "tesseract", {"tesseract": SizeEngine()})
    assert [c.bbox for c in rescued.cells] == [c.bbox for c in plain.cells]


def test_confident_first_pass_skips_the_rescue() -> None:
    engine = StubEngine(confidences=[0.9])
    r = analyze(skewed_table_png(0), "tesseract", {"tesseract": engine})
    assert engine.calls == len(r.cells)


def test_failed_rescue_pass_keeps_the_first_reads() -> None:
    r = analyze(skewed_table_png(0), "tesseract", {"tesseract": SizeEngine(fail_small=True)})
    assert {c.text for c in r.cells} == {"garbled"} and r.needs_fallback == "low_confidence"

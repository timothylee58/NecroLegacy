import cv2
import httpx
import numpy as np
import pytest
import respx

from app.core.llm import LLMRouter
from app.services.vision import VisionError
from app.services.vision_llm import extract_with_llm, prepare_image
from tests.property.test_llm_router import ILMU_URL, make_settings


def table(cells: list[dict], rows: int = 1) -> dict:
    content = (
        '{"rows": ['
        + ",".join("[" + ",".join(__import__("json").dumps(c) for c in cells) + "]" for _ in range(rows))
        + "]}"
    )
    return {"choices": [{"message": {"content": content}}]}


def cell(x: int = 10, text: str = "A\x00B") -> dict:
    return {"text": text, "bbox": {"x": x, "y": 10, "width": 50, "height": 20}, "confidence": 0.8}


def test_prepare_image_downscales_and_strips_metadata() -> None:
    gray = np.zeros((2000, 3000), np.uint8)
    png, scale = prepare_image(gray)
    out = cv2.imdecode(np.frombuffer(png, np.uint8), cv2.IMREAD_GRAYSCALE)
    assert max(out.shape) == 1568 and scale == pytest.approx(1568 / 3000)
    assert b"Exif" not in png and b"tEXt" not in png


@respx.mock
async def test_fallback_scales_boxes_and_sanitizes() -> None:
    respx.post(ILMU_URL).mock(return_value=httpx.Response(200, json=table([cell(100), cell(800)])))
    gray = np.full((2000, 3000), 255, np.uint8)
    result = await extract_with_llm(LLMRouter(make_settings(claude=False)), gray)
    assert result.engine == "ilmu" and result.image_width == 3000
    first = result.cells[0]
    assert first.text == "AB"
    assert first.bbox.x == int(100 * 3000 / 1568)
    assert all(c.bbox.x + c.bbox.width <= 3000 for c in result.cells)


@respx.mock
async def test_box_outside_image_fails_validation() -> None:
    respx.post(ILMU_URL).mock(return_value=httpx.Response(200, json=table([cell(790)])))
    gray = np.full((300, 800), 255, np.uint8)
    with pytest.raises(VisionError) as e:
        await extract_with_llm(LLMRouter(make_settings(claude=False)), gray)
    assert e.value.code == "no_table_detected"


@respx.mock
async def test_empty_rows_fail() -> None:
    respx.post(ILMU_URL).mock(
        return_value=httpx.Response(200, json={"choices": [{"message": {"content": '{"rows": []}'}}]})
    )
    with pytest.raises(VisionError):
        await extract_with_llm(LLMRouter(make_settings(claude=False)), np.full((300, 800), 255, np.uint8))

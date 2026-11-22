import cv2
import httpx
import numpy as np
import pytest
import respx

from app.agents.runtime import Timeouts
from app.core.llm import MAX_RETRY_WAIT_SECONDS, LLMRouter
from app.services.vision import VisionError
from app.services.vision_llm import VISION_TIMEOUT_SECONDS, extract_with_llm, prepare_image
from tests.property.test_llm_router import FALLBACK_URL, PRIMARY_URL, aws_credentials, make_settings


def table(cells: list[dict], rows: int = 1) -> dict:
    content = (
        '{"rows": ['
        + ",".join("[" + ",".join(__import__("json").dumps(c) for c in cells) + "]" for _ in range(rows))
        + "]}"
    )
    return {"output": {"message": {"role": "assistant", "content": [{"text": content}]}}}


def vision_router() -> LLMRouter:
    # Default primary (gpt-oss) is text-only, so image requests go to the vision-capable fallback.
    return LLMRouter(make_settings(), aws_credentials=aws_credentials())


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
    respx.post(FALLBACK_URL).mock(return_value=httpx.Response(200, json=table([cell(100), cell(800)])))
    gray = np.full((2000, 3000), 255, np.uint8)
    result = await extract_with_llm(vision_router(), gray)
    assert result.engine == "fallback" and result.image_width == 3000
    first = result.cells[0]
    assert first.text == "AB"
    assert first.bbox.x == int(100 * 3000 / 1568)
    assert all(c.bbox.x + c.bbox.width <= 3000 for c in result.cells)


@respx.mock
async def test_box_outside_image_fails_validation() -> None:
    respx.post(FALLBACK_URL).mock(return_value=httpx.Response(200, json=table([cell(790)])))
    gray = np.full((300, 800), 255, np.uint8)
    with pytest.raises(VisionError) as e:
        await extract_with_llm(vision_router(), gray)
    assert e.value.code == "no_table_detected"


@respx.mock
async def test_empty_rows_fail() -> None:
    respx.post(FALLBACK_URL).mock(
        return_value=httpx.Response(200, json={"output": {"message": {"content": [{"text": '{"rows": []}'}]}}})
    )
    with pytest.raises(VisionError):
        await extract_with_llm(vision_router(), np.full((300, 800), 255, np.uint8))


def test_one_vision_attempt_fits_the_node_budget() -> None:
    t = Timeouts()
    # Local OCR, an immediate rate-limit answer, the one retry wait, then the single full-length attempt.
    assert t.vision_local + MAX_RETRY_WAIT_SECONDS + VISION_TIMEOUT_SECONDS < t.vision_node


@respx.mock
async def test_vision_call_gets_its_own_timeout() -> None:
    route = respx.post(FALLBACK_URL).mock(return_value=httpx.Response(200, json=table([cell(100)])))
    await extract_with_llm(vision_router(), np.full((300, 800), 255, np.uint8))
    assert route.calls[0].request.extensions["timeout"]["read"] == VISION_TIMEOUT_SECONDS


@respx.mock
async def test_vision_tries_only_one_model() -> None:
    # A vision-capable primary is tried alone; its failure is not followed by a second slow attempt.
    primary = respx.post(PRIMARY_URL).mock(side_effect=httpx.ReadTimeout("slow"))
    fallback = respx.post(FALLBACK_URL).mock(return_value=httpx.Response(200, json=table([cell(100)])))
    router = LLMRouter(
        make_settings().model_copy(update={"llm_primary_vision": True}), aws_credentials=aws_credentials()
    )
    with pytest.raises(VisionError) as e:
        await extract_with_llm(router, np.full((300, 800), 255, np.uint8))
    assert e.value.code == "no_table_detected"
    assert primary.call_count == 1 and fallback.call_count == 0


@respx.mock
async def test_text_only_primary_is_skipped_for_the_single_vision_attempt() -> None:
    primary = respx.post(PRIMARY_URL).mock(return_value=httpx.Response(200, json=table([cell(100)])))
    fallback = respx.post(FALLBACK_URL).mock(side_effect=httpx.ReadTimeout("slow"))
    with pytest.raises(VisionError):
        await extract_with_llm(vision_router(), np.full((300, 800), 255, np.uint8))
    assert primary.call_count == 0 and fallback.call_count == 1

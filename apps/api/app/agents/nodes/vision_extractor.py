import asyncio
import logging

import numpy as np

from app.agents.nodes.base import Completed, NodeError, PoolTimeout
from app.agents.runtime import BusEventSink, Deps
from app.agents.state import AutopsyState
from app.core.llm import ProviderFailure
from app.schemas.autopsy import VisionResult
from app.services import vision
from app.services.vision_llm import extract_with_llm

logger = logging.getLogger("necro.vision")

NO_TABLE = "No table could be read from the image."


async def run(state: AutopsyState, deps: Deps) -> Completed:
    data = state["raw"].data
    gray: np.ndarray | None = None
    local: vision.LocalVision | None = None
    try:
        local = await deps.pool.run(vision.analyze, data, deps.settings.ocr_engine, timeout=deps.timeouts.vision_local)
    except PoolTimeout:
        # Treated as "both engines failed": the worker was killed and the image goes to the vision LLM.
        logger.warning("local vision exceeded %.0f s; using the vision-LLM fallback", deps.timeouts.vision_local)
    except vision.VisionError as exc:
        raise NodeError(exc.code, exc.message) from None

    if local is not None and local.needs_fallback is None:
        confident = _local_result(local)
        return Completed(confident, {"vision": confident})

    # A detected grid whose OCR is merely unsure is still evidence: if the vision LLM cannot do better, keep it.
    # The X-Ray marks every cell below the confidence threshold, so nothing is passed off as certain (4.14 reserves
    # no_table_detected for images where no table was found).
    keep = local if local is not None and local.needs_fallback == "low_confidence" and local.cells else None

    gray = local.image if local is not None and local.image is not None else None
    if gray is None:
        try:
            gray = await asyncio.to_thread(vision.decode_image, data)
        except vision.VisionError as exc:
            raise NodeError(exc.code, exc.message) from None
    if not deps.router.has_provider():
        return _keep_or_fail(keep)
    try:
        result = await extract_with_llm(deps.router, gray, BusEventSink(deps.bus))
    except ProviderFailure:
        return _keep_or_fail(keep)
    except vision.VisionError as exc:
        if exc.code == "cell_limit_exceeded":
            raise NodeError(exc.code, exc.message) from None
        return _keep_or_fail(keep)
    if not result.cells:
        return _keep_or_fail(keep)
    return Completed(result, {"vision": result})


def _local_result(local: vision.LocalVision) -> VisionResult:
    assert local.engine is not None
    return VisionResult(
        image_width=local.image_width,
        image_height=local.image_height,
        skew_angle_degrees=local.skew_angle_degrees,
        engine=local.engine,
        cells=local.cells,
        defects=local.defects,
    )


def _keep_or_fail(keep: vision.LocalVision | None) -> Completed:
    if keep is None:
        raise NodeError("no_table_detected", NO_TABLE)
    logger.warning("vision LLM unavailable or empty; keeping %d low-confidence OCR cells", len(keep.cells))
    result = _local_result(keep)
    return Completed(result, {"vision": result})

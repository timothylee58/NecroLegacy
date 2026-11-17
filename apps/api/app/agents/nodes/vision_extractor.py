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
        assert local.engine is not None
        result = VisionResult(
            image_width=local.image_width,
            image_height=local.image_height,
            skew_angle_degrees=local.skew_angle_degrees,
            engine=local.engine,
            cells=local.cells,
            defects=local.defects,
        )
        return Completed(result, {"vision": result})

    gray = local.image if local is not None and local.image is not None else None
    if gray is None:
        try:
            gray = await asyncio.to_thread(vision.decode_image, data)
        except vision.VisionError as exc:
            raise NodeError(exc.code, exc.message) from None
    if not deps.router.has_provider():
        raise NodeError("no_table_detected", NO_TABLE)
    try:
        result = await extract_with_llm(deps.router, gray, BusEventSink(deps.bus))
    except ProviderFailure:
        raise NodeError("no_table_detected", NO_TABLE) from None
    except vision.VisionError as exc:
        code = exc.code if exc.code == "cell_limit_exceeded" else "no_table_detected"
        raise NodeError(code, exc.message if code != "no_table_detected" else NO_TABLE) from None
    if not result.cells:
        raise NodeError("no_table_detected", NO_TABLE)
    return Completed(result, {"vision": result})

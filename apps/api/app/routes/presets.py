from fastapi import APIRouter, Response

from app.core.errors import ApiError
from app.schemas.autopsy import PresetsResponse
from app.services.presets import get_preset, preset_infos, read_preset

router = APIRouter(prefix="/api")


@router.get("/presets")
async def list_presets() -> PresetsResponse:
    return PresetsResponse(presets=preset_infos())


@router.get("/presets/{preset_id}/image", response_class=Response, responses={200: {"content": {"image/png": {}}}})
async def preset_image(preset_id: str) -> Response:
    preset = get_preset(preset_id)
    if preset is None or preset.kind != "image":
        raise ApiError(404, "not_found", "Preset image not found.")
    return Response(read_preset(preset), media_type="image/png")

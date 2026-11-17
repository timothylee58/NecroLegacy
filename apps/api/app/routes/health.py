from fastapi import APIRouter

from app.schemas.autopsy import HealthResponse

router = APIRouter(prefix="/api")


@router.get("/health")
async def health() -> HealthResponse:
    return HealthResponse(status="ok")

import logging
import uuid
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.schemas.autopsy import ErrorBody, ErrorResponse, FieldError

logger = logging.getLogger("necro.errors")


class ApiError(Exception):
    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        fields: list[FieldError] | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(code)
        self.status = status
        self.code = code
        self.message = message
        self.fields = fields
        self.headers = headers


def error_response(status: int, code: str, message: str, fields: list[FieldError] | None = None) -> JSONResponse:
    body = ErrorResponse(error=ErrorBody(code=code, message=message, fields=fields))
    return JSONResponse(status_code=status, content=body.model_dump(mode="json"))


def _loc(loc: tuple[Any, ...]) -> str:
    return ".".join(str(p) for p in loc if p != "body")


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError) -> JSONResponse:
        response = error_response(exc.status, exc.code, exc.message, exc.fields)
        response.headers.update(exc.headers or {})
        return response

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError) -> JSONResponse:
        # Only the location and the validator's message are returned; `input` is dropped so values never echo.
        fields = [FieldError(field=_loc(tuple(e["loc"])), message=str(e["msg"])) for e in exc.errors()]
        return error_response(422, "validation_error", "Request validation failed", fields)

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = {401: "unauthorized", 404: "not_found", 405: "method_not_allowed"}.get(exc.status_code, "http_error")
        return error_response(exc.status_code, code, str(exc.detail))

    @app.exception_handler(Exception)
    async def _unhandled(_: Request, exc: Exception) -> JSONResponse:
        correlation_id = uuid.uuid4().hex
        logger.error("unhandled error", exc_info=exc, extra={"correlation_id": correlation_id})
        return error_response(500, "internal_error", f"Internal error (correlation id {correlation_id})")

from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import BaseModel, Field

from app.core.errors import ApiError, install_error_handlers


class Body(BaseModel):
    count: int = Field(ge=1)


def make_app():
    app = FastAPI()
    install_error_handlers(app)
    state = {"calls": 0}

    @app.post("/x")
    def x(body: Body):
        state["calls"] += 1
        return {}

    @app.get("/boom")
    def boom():
        raise RuntimeError("secret-detail")

    @app.get("/api-error")
    def api_error():
        raise ApiError(404, "session_not_found", "No such session")

    return app, state


def test_validation_error_lists_fields_and_does_not_echo_values():
    app, state = make_app()
    r = TestClient(app).post("/x", json={"count": "SECRET-VALUE"})
    assert r.status_code == 422
    body = r.json()["error"]
    assert body["code"] == "validation_error"
    assert body["fields"][0]["field"] == "count"
    assert "SECRET-VALUE" not in r.text
    assert state["calls"] == 0


def test_unhandled_error_returns_correlation_id_without_detail():
    app, _ = make_app()
    r = TestClient(app, raise_server_exceptions=False).get("/boom")
    assert r.status_code == 500
    assert r.json()["error"]["code"] == "internal_error"
    assert "secret-detail" not in r.text
    assert "correlation id" in r.json()["error"]["message"]


def test_api_error_shape():
    app, _ = make_app()
    r = TestClient(app).get("/api-error")
    assert r.status_code == 404 and r.json() == {
        "error": {"code": "session_not_found", "message": "No such session", "fields": None}
    }

from fastapi.testclient import TestClient
from hypothesis import given
from hypothesis import strategies as st
from starlette.requests import Request

from app.core.ratelimit import SlidingWindowLimiter, client_key
from app.main import create_app
from tests.integration.test_api import make_ctx


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def _request(real_ip: str | None, host: str = "10.0.0.9") -> Request:
    headers = [(b"x-real-ip", real_ip.encode()), (b"x-forwarded-for", b"6.6.6.6")] if real_ip is not None else []
    return Request({"type": "http", "headers": headers, "client": (host, 1234)})


def test_allows_limit_then_blocks_until_window_passes():
    clock = FakeClock()
    lim = SlidingWindowLimiter(3, 60, clock)
    assert [lim.check("a") for _ in range(3)] == [None, None, None]
    wait = lim.check("a")
    assert wait is not None and 59 < wait <= 60
    assert lim.check("b") is None
    clock.now += 60.01
    assert lim.check("a") is None


def test_blocked_attempts_do_not_extend_the_window():
    clock = FakeClock()
    lim = SlidingWindowLimiter(1, 10, clock)
    assert lim.check("a") is None
    for _ in range(50):
        clock.now += 0.1
        assert lim.check("a") is not None
    clock.now = 1010.01
    assert lim.check("a") is None


@given(st.lists(st.floats(min_value=0, max_value=5), min_size=1, max_size=200), st.integers(1, 10))
def test_never_admits_more_than_limit_per_window(gaps, limit):
    clock = FakeClock()
    lim = SlidingWindowLimiter(limit, 10, clock)
    admitted: list[float] = []
    for gap in gaps:
        clock.now += gap
        if lim.check("k") is None:
            admitted.append(clock.now)
    for t in admitted:
        assert sum(1 for u in admitted if t - 10 < u <= t) <= limit


def test_client_key_ignores_headers_unless_one_is_trusted():
    assert client_key(_request("203.0.113.7"), None) == "10.0.0.9"


def test_client_key_reads_only_the_trusted_header():
    assert client_key(_request("203.0.113.7"), "x-real-ip") == "203.0.113.7"


def test_client_key_falls_back_to_the_peer_when_the_header_is_missing():
    assert client_key(_request(None), "x-real-ip") == "10.0.0.9"


def test_client_ip_header_setting_is_normalised():
    assert make_ctx(client_ip_header=" X-Real-IP ").settings.client_ip_header == "x-real-ip"
    assert make_ctx(client_ip_header="  ").settings.client_ip_header is None


def test_preset_sessions_return_429_with_retry_after():
    ctx = make_ctx(rate_limit_sessions_per_hour=2)
    with TestClient(create_app(ctx.settings, ctx)) as c:
        codes = [c.post("/api/sessions/preset", json={"preset_id": "ledger_1994"}).status_code for _ in range(3)]
        assert codes == [201, 201, 429]
        res = c.post("/api/sessions/preset", json={"preset_id": "ledger_1994"})
        assert res.json()["error"]["code"] == "rate_limited"
        assert 1 <= int(res.headers["retry-after"]) <= 3600


def test_uploads_share_the_session_budget_with_presets():
    ctx = make_ctx(rate_limit_sessions_per_hour=1)
    with TestClient(create_app(ctx.settings, ctx)) as c:
        assert c.post("/api/sessions/preset", json={"preset_id": "ledger_1994"}).status_code == 201
        res = c.post("/api/sessions", files={"file": ("a.csv", b"id,qty\n1,5\n")})
        assert res.status_code == 429

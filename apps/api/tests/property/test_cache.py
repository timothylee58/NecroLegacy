import asyncio
import logging

import fakeredis
from hypothesis import given, settings
from hypothesis import strategies as st

from app.schemas.autopsy import SessionEvent
from app.services.cache import ResultCache, cache_key, decode, encode, resolve_ttl

text = st.text(max_size=20)


@st.composite
def event_lists(draw):
    out = []
    for i in range(1, draw(st.integers(1, 6)) + 1):
        kind = draw(st.sampled_from(["started", "skipped", "failed"]))
        payload = {
            "started": {},
            "skipped": {"reason": draw(text)},
            "failed": {"code": draw(text), "message": draw(text)},
        }[kind]
        out.append(
            SessionEvent(
                id=i,
                type="node",
                node=draw(st.sampled_from(["vision_extractor", "ml_rot_scorer"])),
                state=kind,
                payload=payload,
            )
        )
    out.append(SessionEvent(id=len(out) + 1, type="terminal", payload={"status": "completed", "failed_node": None}))
    return out


def run(coro):
    return asyncio.run(coro)


@settings(max_examples=40, deadline=None)
@given(event_lists(), st.sampled_from(["text", "image"]))
def test_encode_decode_round_trip(events, kind):
    result = decode(encode(kind, events))
    assert result.events == events and result.input_kind == kind


@settings(max_examples=25, deadline=None)
@given(event_lists(), st.integers(60, 604_800), st.binary(min_size=1, max_size=64))
def test_redis_round_trip_with_ttl(events, ttl, data):
    async def go():
        redis = fakeredis.FakeAsyncRedis()
        cache = ResultCache(redis, ttl)
        key = cache_key(data)
        assert await cache.set(key, "text", events)
        got = await cache.get(key)
        remaining = await redis.ttl(key)
        return got, remaining

    got, remaining = run(go())
    assert got is not None and got.events == events and got.input_kind == "text"
    assert 60 <= remaining <= 604_800


@given(st.one_of(st.none(), st.text(max_size=8), st.integers(-10, 1_000_000), st.just(59), st.just(604_801)))
def test_invalid_ttl_falls_back(value):
    ttl = resolve_ttl(value)
    assert 60 <= ttl <= 604_800
    try:
        parsed = int(str(value).strip())
    except ValueError:
        parsed = None
    if parsed is None or not 60 <= parsed <= 604_800:
        assert ttl == 86_400


@given(st.binary(max_size=50), st.binary(max_size=50), st.binary(max_size=50), st.binary(max_size=50))
def test_key_equality_tracks_byte_equality(a, b, c, d):
    assert (cache_key(a) == cache_key(b)) == (a == b)
    assert (cache_key(a, c) == cache_key(b, d)) == (a == b and c == d)


def test_length_prefix_separates_split_points():
    assert cache_key(b"ab", b"c") != cache_key(b"a", b"bc")


def test_unavailable_cache_is_miss_with_one_warning(caplog):
    class Broken:
        async def get(self, key):
            raise ConnectionError("boom")

        async def set(self, key, value, ex=None):
            raise ConnectionError("boom")

    events = [SessionEvent(id=1, type="terminal", payload={"status": "completed", "failed_node": None})]

    async def go():
        cache = ResultCache(Broken(), 100)
        return await cache.get("necro:result:k"), await cache.set("necro:result:k", "text", events)

    with caplog.at_level(logging.WARNING, logger="necro.cache"):
        got, stored = run(go())
    assert got is None and stored is False
    assert len(caplog.records) == 2 and all("necro:result" not in r.getMessage() for r in caplog.records)


def test_failed_sessions_are_not_stored():
    events = [SessionEvent(id=1, type="terminal", payload={"status": "failed", "failed_node": "ml_rot_scorer"})]

    async def go():
        redis = fakeredis.FakeAsyncRedis()
        stored = await ResultCache(redis, 100).set("k", "text", events)
        return stored, await redis.exists("k")

    assert run(go()) == (False, 0)

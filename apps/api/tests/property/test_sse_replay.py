import asyncio

from hypothesis import given, settings
from hypothesis import strategies as st

from app.services.sessions import EventLog
from tests.strategies import non_terminal_events


async def _collect(log: EventLog, after: int) -> list[int]:
    return [e.id async for e in log.subscribe(after)]


# Feature: digital-autopsy-engine, Property 12: SSE ordering and replay
@settings(max_examples=100, deadline=None)
@given(events=st.lists(non_terminal_events(), min_size=0, max_size=20), k_seed=st.integers(min_value=0))
def test_replay_from_any_point_yields_exact_suffix(events, k_seed):
    async def run():
        log = EventLog()
        for type_, payload, node, state in events:
            await log.append(type_, payload, node=node, state=state)
        await log.append("terminal", {"status": "completed"})
        n = log.last_id
        k = k_seed % (n + 1)
        assert await _collect(log, k) == list(range(k + 1, n + 1))
        assert [e.id for e in log.events()] == list(range(1, n + 1))

    asyncio.run(run())


@settings(max_examples=50, deadline=None)
@given(events=st.lists(non_terminal_events(), min_size=1, max_size=15), split=st.integers(min_value=0, max_value=15))
def test_concurrent_appends_during_replay_have_no_gaps_or_duplicates(events, split):
    async def run():
        log = EventLog()
        head, tail = events[: split % len(events)], events[split % len(events) :]
        for type_, payload, node, state in head:
            await log.append(type_, payload, node=node, state=state)
        reader = asyncio.create_task(_collect(log, 0))
        await asyncio.sleep(0)
        for type_, payload, node, state in tail:
            await log.append(type_, payload, node=node, state=state)
            await asyncio.sleep(0)
        await log.append("terminal", {"status": "completed"})
        ids = await asyncio.wait_for(reader, 2)
        assert ids == list(range(1, log.last_id + 1))

    asyncio.run(run())

import asyncio

import pytest

from app.services.sessions import EventLog, SessionStore, fold_events


async def test_ids_start_at_one_and_increase():
    log = EventLog()
    a = await log.append("node", {}, node="vision_extractor", state="started")
    b = await log.append("node", {"reason": "text_input"}, node="vision_extractor", state="skipped")
    assert (a.id, b.id) == (1, 2)


async def test_invalid_payload_rejected_and_not_stored():
    log = EventLog()
    with pytest.raises(ValueError):
        await log.append("node", {"bogus": 1}, node="rot_detector", state="failed")
    assert log.last_id == 0


async def test_append_after_terminal_rejected():
    log = EventLog()
    await log.append("terminal", {"status": "completed"})
    with pytest.raises(RuntimeError):
        await log.append("fallback", {"failed_provider": "ilmu", "reason": "error"})


async def test_subscribe_replays_then_waits_for_new_events():
    log = EventLog()
    await log.append("node", {}, node="vision_extractor", state="started")
    got: list[int] = []

    async def reader():
        async for e in log.subscribe(0):
            got.append(e.id)

    task = asyncio.create_task(reader())
    await asyncio.sleep(0.01)
    await log.append("node", {"reason": "x"}, node="vision_extractor", state="skipped")
    await log.append("terminal", {"status": "failed", "failed_node": "vision_extractor"})
    await asyncio.wait_for(task, 1)
    assert got == [1, 2, 3]


async def test_fold_events_status_and_node_status():
    log = EventLog()
    await log.append("node", {}, node="vision_extractor", state="started")
    await log.append("node", {"code": "c", "message": "m"}, node="vision_extractor", state="failed")
    await log.append("terminal", {"status": "failed", "failed_node": "vision_extractor"})
    snap = fold_events("s", "image", log.events())
    assert snap.status == "failed" and snap.node_status == {"vision_extractor": "failed"} and snap.last_event_id == 3


async def test_store_index_key_defaults_to_own_id_and_retention():
    store = SessionStore(retention_seconds=0)
    s = store.create("text")
    assert s.index_key == s.id
    other = store.create("text", index_key=s.id)
    assert other.index_key == s.id and other.id != s.id
    store.mark_finished(s)
    await asyncio.sleep(0.01)
    assert store.get(s.id) is None

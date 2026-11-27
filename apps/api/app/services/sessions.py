import asyncio
import time
import uuid
from collections.abc import AsyncIterator, Callable, Iterable
from dataclasses import dataclass, field
from typing import Any, Literal

from app.schemas.autopsy import NodeState, SessionEvent, SessionSnapshot, payload_model

SESSION_RETENTION_SECONDS = 7_200
SessionStatus = Literal["queued", "running", "completed", "failed"]


class EventLog:
    def __init__(self, preloaded: Iterable[SessionEvent] = ()) -> None:
        self._events: list[SessionEvent] = list(preloaded)
        self._lock = asyncio.Lock()
        self._cond = asyncio.Condition()
        self._closed = any(e.type == "terminal" for e in self._events)
        # Transient failures behind a "completed" run (e.g. an LLM call that failed). Kept off the event stream so a
        # cached replay stays byte-identical; used only to decide whether the result may be cached.
        self.degraded: set[str] = set()

    @property
    def last_id(self) -> int:
        return len(self._events)

    @property
    def closed(self) -> bool:
        return self._closed

    def events(self) -> list[SessionEvent]:
        return list(self._events)

    def mark_degraded(self, cause: str) -> None:
        self.degraded.add(cause)

    async def append(
        self,
        type_: str,
        payload: dict[str, Any],
        *,
        node: str | None = None,
        state: str | None = None,
    ) -> SessionEvent:
        model = payload_model(type_, node, state)
        validated = model.model_validate(payload).model_dump(mode="json", exclude_unset=False)
        async with self._lock:
            if self._closed:
                raise RuntimeError("event log is closed")
            event = SessionEvent.model_validate(
                {
                    "id": len(self._events) + 1,
                    "type": type_,
                    "node": node,
                    "state": state,
                    "payload": validated,
                }
            )
            self._events.append(event)
            if type_ == "terminal":
                self._closed = True
        async with self._cond:
            self._cond.notify_all()
        return event

    def _ready_after(self, cursor: int) -> Callable[[], bool]:
        return lambda: len(self._events) > cursor or self._closed

    async def subscribe(self, after_id: int = 0) -> AsyncIterator[SessionEvent]:
        cursor = after_id
        while True:
            async with self._cond:
                await self._cond.wait_for(self._ready_after(cursor))
                batch = self._events[cursor:]
            for event in batch:
                cursor = event.id
                yield event
            if self._closed and cursor >= len(self._events):
                return


def fold_events(
    session_id: str,
    input_kind: Literal["text", "image"],
    events: Iterable[SessionEvent],
    *,
    served_from_cache: bool = False,
    running: bool = False,
) -> SessionSnapshot:
    node_status: dict[str, NodeState] = {}
    results: dict[str, Any] = {}
    key_for = {
        "vision_extractor": "vision",
        "schema_archaeologist": "schema",
        "ml_rot_scorer": "ml",
        "rot_detector": "rot",
        "api_resurrector": "resurrection",
    }
    status: SessionStatus = "running" if running else "queued"
    last_id = 0
    for event in events:
        last_id = event.id
        if event.type == "node" and event.node and event.state:
            node_status[event.node] = event.state
            if event.state == "completed":
                model = payload_model("node", event.node, "completed")
                results[key_for[event.node]] = model.model_validate(event.payload)
            status = "running"
        elif event.type == "terminal":
            status = "completed" if event.payload.get("status") == "completed" else "failed"
    return SessionSnapshot.model_validate(
        {
            "session_id": session_id,
            "input_kind": input_kind,
            "status": status,
            "served_from_cache": served_from_cache,
            "node_status": node_status,
            "last_event_id": last_id,
            **results,
        }
    )


@dataclass
class Session:
    id: str
    input_kind: Literal["text", "image"]
    log: EventLog
    index_key: str
    content_hash: str = ""
    served_from_cache: bool = False
    embedding_provider: str = "hash"
    created_at: float = field(default_factory=time.monotonic)
    finished_at: float | None = None
    task: asyncio.Task[None] | None = None
    indexed: bool = False

    def snapshot(self) -> SessionSnapshot:
        running = self.task is not None and not self.task.done()
        return fold_events(
            self.id,
            self.input_kind,
            self.log.events(),
            served_from_cache=self.served_from_cache,
            running=running,
        )


class SessionStore:
    def __init__(self, retention_seconds: int = SESSION_RETENTION_SECONDS) -> None:
        self._sessions: dict[str, Session] = {}
        self._retention = retention_seconds

    def create(
        self,
        input_kind: Literal["text", "image"],
        *,
        index_key: str | None = None,
        content_hash: str = "",
        preloaded: Iterable[SessionEvent] = (),
        served_from_cache: bool = False,
    ) -> Session:
        self.purge()
        session_id = str(uuid.uuid4())
        session = Session(
            id=session_id,
            input_kind=input_kind,
            log=EventLog(preloaded),
            index_key=index_key or session_id,
            content_hash=content_hash,
            served_from_cache=served_from_cache,
        )
        if session.log.closed:
            session.finished_at = time.monotonic()
        self._sessions[session_id] = session
        return session

    def get(self, session_id: str) -> Session | None:
        self.purge()
        return self._sessions.get(session_id)

    def mark_finished(self, session: Session) -> None:
        session.finished_at = time.monotonic()

    def purge(self) -> None:
        now = time.monotonic()
        expired = [
            sid
            for sid, s in self._sessions.items()
            if s.finished_at is not None and now - s.finished_at > self._retention
        ]
        for sid in expired:
            del self._sessions[sid]

    def __len__(self) -> int:
        return len(self._sessions)

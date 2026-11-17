import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Literal

from langchain_core.runnables import RunnableConfig
from langgraph.graph import END, START, StateGraph

from app.agents.nodes import archaeologist, ml_rot_scorer, resurrector, rot_detector, vision_extractor
from app.agents.nodes.base import Completed, NodeError, Skipped
from app.agents.runtime import Deps, Timeouts
from app.agents.state import AutopsyState, NodeFailure, RawInput
from app.schemas.autopsy import NodeName

logger = logging.getLogger("necro.pipeline")

NodeBody = Callable[[AutopsyState, Deps], Awaitable[Completed | Skipped]]


@dataclass
class _Tracker:
    current: NodeName | None = None


_TIMEOUT_CODES: dict[NodeName, str] = {
    "vision_extractor": "vision_timeout",
    "schema_archaeologist": "archaeologist_timeout",
    "ml_rot_scorer": "timeout",
    "rot_detector": "rot_timeout",
    "api_resurrector": "resurrector_timeout",
}


def _node_timeout(name: NodeName, t: Timeouts) -> float:
    return {
        "vision_extractor": t.vision_node,
        "schema_archaeologist": t.archaeologist,
        # The pool enforces the 30 s ML limit; this outer limit only catches a wedged event loop handoff.
        "ml_rot_scorer": t.ml + 5.0,
        "rot_detector": t.rot_deterministic + t.rot_semantic + 5.0,
        "api_resurrector": t.indexing + t.generation + 5.0,
    }[name]


def _ctx(config: RunnableConfig) -> tuple[Deps, _Tracker]:
    configurable = config.get("configurable") or {}
    return configurable["deps"], configurable["tracker"]


async def _fail(deps: Deps, name: NodeName, err: NodeError) -> dict[str, Any]:
    await deps.bus.append("node", {"code": err.code, "message": err.message}, node=name, state="failed")
    error: dict[str, Any] = {"node": name, "code": err.code, "message": err.message}
    if err.fields:
        error["fields"] = [f.model_dump() for f in err.fields]
    await deps.bus.append("error", error)
    return {
        **err.updates,
        "node_status": {name: "failed"},
        "failure": NodeFailure(name, err.code, err.message, err.fields),
    }


def instrument(name: NodeName, body: NodeBody, *, defer_started: bool = False) -> Any:
    """Returns Any: LangGraph's node protocols match on the parameter name `config`, which Callable[...] loses."""

    async def node(state: AutopsyState, config: RunnableConfig) -> dict[str, Any]:
        deps, tracker = _ctx(config)
        if not defer_started:
            await deps.bus.append("node", {}, node=name, state="started")
        tracker.current = name
        try:
            async with asyncio.timeout(_node_timeout(name, deps.timeouts)):
                outcome = await body(state, deps)
        except NodeError as err:
            return await _fail(deps, name, err)
        except TimeoutError:
            return await _fail(deps, name, NodeError(_TIMEOUT_CODES[name], f"{name} exceeded its time limit."))
        except Exception:
            logger.exception("%s raised an unexpected error", name)
            return await _fail(deps, name, NodeError("internal_error", f"{name} failed unexpectedly."))
        finally:
            tracker.current = None
        if isinstance(outcome, Skipped):
            await deps.bus.append("node", {"reason": outcome.reason}, node=name, state="skipped")
            return {**outcome.updates, "node_status": {name: "skipped"}}
        if defer_started:
            # A skipped node must never be preceded by `started` (10.4), and the ML skip is only known after scoring.
            await deps.bus.append("node", {}, node=name, state="started")
        await deps.bus.append("node", outcome.payload.model_dump(mode="json"), node=name, state="completed")
        return {**outcome.updates, "node_status": {name: "completed"}}

    node.__name__ = name
    return node


async def _route(state: AutopsyState, config: RunnableConfig) -> dict[str, Any]:
    deps, _ = _ctx(config)
    already_logged = any(e.node == "vision_extractor" and e.state == "skipped" for e in deps.bus.events())
    if state["input_kind"] == "text" and not already_logged:
        await deps.bus.append("node", {"reason": "text_input"}, node="vision_extractor", state="skipped")
    if state["input_kind"] == "text":
        return {"node_status": {"vision_extractor": "skipped"}}
    return {}


async def _skip_resurrector(state: AutopsyState, config: RunnableConfig) -> dict[str, Any]:
    deps, _ = _ctx(config)
    await deps.bus.append("node", {"reason": "rot_detector_failed"}, node="api_resurrector", state="skipped")
    return {"node_status": {"api_resurrector": "skipped"}}


def _first(state: AutopsyState) -> Literal["vision_extractor", "schema_archaeologist"]:
    return "vision_extractor" if state["input_kind"] == "image" else "schema_archaeologist"


def _stop_on_failure(next_node: str) -> Callable[[AutopsyState], str]:
    def edge(state: AutopsyState) -> str:
        return END if state.get("failure") is not None else next_node

    return edge


def _after_rot(state: AutopsyState) -> Literal["api_resurrector", "skip_resurrector"]:
    return "skip_resurrector" if state.get("failure") is not None else "api_resurrector"


@lru_cache(maxsize=1)
def build_graph() -> Any:
    g = StateGraph(AutopsyState)
    g.add_node("route", _route)
    g.add_node("vision_extractor", instrument("vision_extractor", vision_extractor.run))
    g.add_node("schema_archaeologist", instrument("schema_archaeologist", archaeologist.run))
    g.add_node("ml_rot_scorer", instrument("ml_rot_scorer", ml_rot_scorer.run, defer_started=True))
    g.add_node("rot_detector", instrument("rot_detector", rot_detector.run))
    g.add_node("api_resurrector", instrument("api_resurrector", resurrector.run))
    g.add_node("skip_resurrector", _skip_resurrector)
    g.add_edge(START, "route")
    g.add_conditional_edges("route", _first, ["vision_extractor", "schema_archaeologist"])
    g.add_conditional_edges("vision_extractor", _stop_on_failure("schema_archaeologist"), ["schema_archaeologist", END])
    g.add_conditional_edges("schema_archaeologist", _stop_on_failure("ml_rot_scorer"), ["ml_rot_scorer", END])
    # ml_rot_scorer never sets `failure`: every error there becomes `skipped`.
    g.add_edge("ml_rot_scorer", "rot_detector")
    g.add_conditional_edges("rot_detector", _after_rot, ["api_resurrector", "skip_resurrector"])
    g.add_edge("api_resurrector", END)
    g.add_edge("skip_resurrector", END)
    return g.compile()


async def run_pipeline(
    *,
    session_id: str,
    input_kind: Literal["text", "image"],
    raw: RawInput,
    deps: Deps,
    index_key: str | None = None,
) -> AutopsyState:
    tracker = _Tracker()
    initial: AutopsyState = {
        "session_id": session_id,
        "index_key": index_key or session_id,
        "input_kind": input_kind,
        "raw": raw,
        "node_status": {},
        "failure": None,
    }
    config: RunnableConfig = {"configurable": {"deps": deps, "tracker": tracker}}
    final: AutopsyState = initial
    failed_node: NodeName | None = None
    try:
        async with asyncio.timeout(deps.timeouts.session):
            final = await build_graph().ainvoke(initial, config=config)
    except TimeoutError:
        failed_node = tracker.current
        if failed_node is not None:
            await _fail(deps, failed_node, NodeError("session_timeout", "The session exceeded 600 seconds."))
    except Exception:
        logger.exception("pipeline crashed")
        failed_node = tracker.current
        if failed_node is not None:
            await _fail(deps, failed_node, NodeError("internal_error", f"{failed_node} failed unexpectedly."))
    else:
        failure = final.get("failure")
        failed_node = failure.node if failure is not None else None
        if failure is None and final.get("node_status", {}).get("api_resurrector") != "completed":
            failed_node = "api_resurrector"
    if failed_node is None and final is initial:
        await deps.bus.append("terminal", {"status": "failed"})
    elif failed_node is None:
        await deps.bus.append("terminal", {"status": "completed"})
    else:
        await deps.bus.append("terminal", {"status": "failed", "failed_node": failed_node})
    return final

import { describe, expect, it } from "vitest";
import {
  buildEventScript,
  LEDGER_ML,
  LEDGER_SCHEMA,
  ML_SKIPPED_SCRIPT,
  ROT_DETECTOR_FAILURE_SCRIPT,
  TEXT_EVENT_SCRIPT,
} from "@/lib/mock-autopsy";
import { initialState, sessionReducer } from "@/lib/session-reducer";
import type { SessionEvent } from "@/types/autopsy";

function run(script: SessionEvent[], cached = false, inputKind: "text" | "image" = "text") {
  let state = sessionReducer(initialState(), { type: "session_started", inputKind, cached });
  for (const e of script) state = sessionReducer(state, e);
  return state;
}

describe("sessionReducer", () => {
  it("marks vision_extractor skipped first for text input and completes the rest", () => {
    expect(TEXT_EVENT_SCRIPT[0]).toMatchObject({ node: "vision_extractor", state: "skipped" });
    const first = sessionReducer(initialState(), TEXT_EVENT_SCRIPT[0]!);
    expect(first.nodeStatus.vision_extractor).toBe("skipped");
    expect(first.vision).toBeNull();

    const end = run(TEXT_EVENT_SCRIPT);
    expect(end.nodeStatus).toEqual({
      vision_extractor: "skipped",
      schema_archaeologist: "completed",
      ml_rot_scorer: "completed",
      rot_detector: "completed",
      api_resurrector: "completed",
    });
    expect(end.phase).toBe("completed");
    expect(end.currentNode).toBeNull();
  });

  it("keeps earlier results and skips api_resurrector when rot_detector fails", () => {
    const end = run(ROT_DETECTOR_FAILURE_SCRIPT);
    expect(end.nodeStatus.rot_detector).toBe("failed");
    expect(end.nodeStatus.api_resurrector).toBe("skipped");
    expect(end.nodeStatus.schema_archaeologist).toBe("completed");
    expect(end.nodeStatus.ml_rot_scorer).toBe("completed");
    expect(end.schema).toEqual(LEDGER_SCHEMA);
    expect(end.ml).toEqual(LEDGER_ML);
    expect(end.rot).toBeNull();
    expect(end.resurrection).toBeNull();
    expect(end.phase).toBe("failed");
    expect(end.currentNode).toBeNull();
  });

  it("does not overwrite a non-pending api_resurrector status on rot_detector failure", () => {
    let state = sessionReducer(initialState(), {
      id: 1,
      type: "node",
      node: "api_resurrector",
      state: "started",
      payload: {},
    });
    state = sessionReducer(state, {
      id: 2,
      type: "error",
      payload: { node: "rot_detector", code: "rot_detector_failed", message: "x" },
    });
    expect(state.nodeStatus.api_resurrector).toBe("started");
  });

  it("records ml_rot_scorer skipped with no ML result while later nodes complete", () => {
    expect(ML_SKIPPED_SCRIPT.some((e) => e.type === "node" && e.node === "ml_rot_scorer" && e.state === "skipped")).toBe(true);
    const end = run(ML_SKIPPED_SCRIPT);
    expect(end.nodeStatus.ml_rot_scorer).toBe("skipped");
    expect(end.ml).toBeNull();
    expect(end.nodeStatus.rot_detector).toBe("completed");
    expect(end.nodeStatus.api_resurrector).toBe("completed");
    expect(end.phase).toBe("completed");
  });

  it("sets the cache indicator from session_started and clears it on reset", () => {
    const cached = run([], true);
    expect(cached.servedFromCache).toBe(true);
    expect(cached.phase).toBe("running");
    expect(run([], false).servedFromCache).toBe(false);
    expect(sessionReducer(cached, { type: "reset" }).servedFromCache).toBe(false);
  });

  it("session_started discards prior results and records input kind", () => {
    const done = run(buildEventScript({ input: "image" }), false, "image");
    expect(done.vision).not.toBeNull();
    const next = sessionReducer(done, { type: "session_started", inputKind: "text", cached: true });
    expect(next.vision).toBeNull();
    expect(next.schema).toBeNull();
    expect(next.inputKind).toBe("text");
    expect(next.servedFromCache).toBe(true);
  });
});

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FNB_EVENT_SCRIPT,
  IMAGE_EVENT_SCRIPT,
  ML_SKIPPED_SCRIPT,
  ROT_DETECTOR_FAILURE_SCRIPT,
  TEXT_EVENT_SCRIPT,
} from "./mock-autopsy";

// Feeds apps/api/tests/contract, which validates these streams against the Pydantic event models.
describe("mock event export", () => {
  it("writes the mock scripts as JSON", () => {
    const scripts = {
      text: TEXT_EVENT_SCRIPT,
      fnb: FNB_EVENT_SCRIPT,
      image: IMAGE_EVENT_SCRIPT,
      rot_detector_failure: ROT_DETECTOR_FAILURE_SCRIPT,
      ml_skipped: ML_SKIPPED_SCRIPT,
    };
    const dir = path.resolve(__dirname, "../../contract/generated");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "mock-events.json"), JSON.stringify(scripts));
    expect(Object.values(scripts).every((s) => s.length > 0)).toBe(true);
  });
});

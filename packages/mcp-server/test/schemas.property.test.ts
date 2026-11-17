import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invalidParameters } from "../src/schemas.js";
import { inspectLegacySchema, queryRotAnomalies } from "../src/tools.js";
import { parse, setEnv, stubFetch } from "./helpers.js";

beforeEach(setEnv);
afterEach(() => vi.unstubAllGlobals());

describe("input validation", () => {
  it("names every invalid parameter and never calls fetch (query_rot_anomalies)", async () => {
    const fetchMock = stubFetch(() => new Response("{}"));
    await fc.assert(
      fc.asyncProperty(
        fc.string().filter((s) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)),
        fc.string().filter((s) => !["low", "medium", "critical"].includes(s)),
        fc.oneof(fc.constant(""), fc.string({ minLength: 129, maxLength: 140 })),
        async (session_id, severity, entity) => {
          const result = await queryRotAnomalies({ session_id, severity, entity });
          const body = parse(result);
          expect(result.isError).toBe(true);
          expect(body.error.parameters).toEqual(expect.arrayContaining(["session_id", "severity", "entity"]));
        },
      ),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects unknown and missing parameters by name", async () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }).filter((k) => !["session_id", "severity", "entity"].includes(k)), (key) => {
        const names = invalidParameters("query_rot_anomalies", { [key]: 1 });
        expect(names).toContain("session_id");
        expect(names).toContain(key === "__proto__" ? "session_id" : key);
      }),
    );
  });

  it("requires exactly one of file_path and preset", async () => {
    const fetchMock = stubFetch(() => new Response("{}"));
    for (const args of [{}, { file_path: "a.dat", preset: "Faded Dot-Matrix Manifest" }, { file_path: "" }, { preset: "nope" }]) {
      const result = await inspectLegacySchema(args);
      expect(result.isError).toBe(true);
      expect(parse(result).error.parameters.length).toBeGreaterThan(0);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

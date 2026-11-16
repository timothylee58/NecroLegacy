import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { SseFrameParser } from "./sse-client";

// Feature: digital-autopsy-engine, Property 12: SSE ordering and replay
function encodeStream(n: number): string {
  let out = "";
  for (let id = 1; id <= n; id++) {
    const body = JSON.stringify({ id, type: "error", payload: { node: "rot_detector", code: "c", message: `m${id}` } });
    out += `id: ${id}\nevent: error\ndata: ${body}\n\n`;
    if (id % 3 === 0) out += ": keepalive\n\n";
  }
  return out;
}

function splitAt(text: string, cuts: number[]): string[] {
  const points = [...new Set(cuts.map((c) => c % (text.length + 1)))].sort((a, b) => a - b);
  const parts: string[] = [];
  let prev = 0;
  for (const p of points) {
    parts.push(text.slice(prev, p));
    prev = p;
  }
  parts.push(text.slice(prev));
  return parts;
}

describe("Property 12: SSE ordering and replay (client parsing)", () => {
  it("yields the same ordered frames for any chunk split", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 30 }),
        fc.array(fc.nat(), { maxLength: 40 }),
        (n, cuts) => {
          const text = encodeStream(n);
          const parser = new SseFrameParser();
          const ids = splitAt(text, cuts).flatMap((c) => parser.push(c).map((f) => f.id));
          expect(ids).toEqual(Array.from({ length: n }, (_, i) => i + 1));
        },
      ),
      { numRuns: 100 },
    );
  });

  it("resuming at any point k yields exactly the remaining suffix", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 30 }),
        fc.nat(),
        fc.array(fc.nat(), { maxLength: 20 }),
        (n, kSeed, cuts) => {
          const k = kSeed % (n + 1);
          const all = encodeStream(n);
          const parser = new SseFrameParser();
          const frames = splitAt(all, cuts).flatMap((c) => parser.push(c));
          const resumed = frames.filter((f) => (f.id ?? 0) > k).map((f) => f.id);
          expect(resumed).toEqual(Array.from({ length: n - k }, (_, i) => k + i + 1));
        },
      ),
      { numRuns: 100 },
    );
  });
});

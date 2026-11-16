import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import fc from "fast-check";

const css = readFileSync(join(__dirname, "globals.css"), "utf8");

describe("globals.css", () => {
  it("declares a global focus-visible outline of at least 2px", () => {
    const m = /:focus-visible\s*{[^}]*outline:\s*(\d+)px\s+solid/.exec(css);
    expect(m).not.toBeNull();
    expect(Number(m?.[1])).toBeGreaterThanOrEqual(2);
  });

  it("is stable under repeated reads", () => {
    fc.assert(fc.property(fc.nat(5), () => css.includes(":focus-visible")));
  });
});

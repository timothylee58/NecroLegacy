import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Anomaly, Entity } from "@/types/autopsy";
import { CRIMSON, SLATE } from "@/lib/scene/palette";
import { contrastRatio, meetsNonTextContrast, meetsTextContrast } from "./contrast";
import {
  MAX_ANNOUNCEMENT_LENGTH,
  describeEntitySummary,
  highestSeverity,
  resultAnnouncement,
  summarizeEntities,
  toAnnouncement,
} from "./summary";

const entity = (name: string, targets: string[] = []): Entity => ({
  name,
  position_unit: "column",
  fields: [],
  primary_key: { fields: [], confidence: 1 } as unknown as Entity["primary_key"],
  foreign_keys: targets.map((t) => ({ source_field: "x", target_entity: t, target_field: "id", confidence: 1 })),
  row_count: 0,
  record_length: null,
});
const anomaly = (entityName: string, severity: Anomaly["severity"]): Anomaly =>
  ({ id: `${entityName}-${severity}`, entity: entityName, severity }) as Anomaly;

describe("summary", () => {
  it("reports zero counts and no related entities", () => {
    const s = summarizeEntities([entity("A")], [])[0]!;
    expect(s.counts).toEqual({ low: 0, medium: 0, critical: 0 });
    expect(describeEntitySummary(s)).toBe(
      "A: 0 low, 0 medium, 0 critical anomalies. Related entities: none.",
    );
    expect(highestSeverity(s.counts)).toBeNull();
  });

  it("counts per severity and relates entities in both directions", () => {
    const res = summarizeEntities(
      [entity("A", ["B", "Missing"]), entity("B"), entity("C", ["B"])],
      [anomaly("A", "critical"), anomaly("A", "low"), anomaly("A", "low"), anomaly("B", "medium")],
    );
    const a = res[0]!;
    const b = res[1]!;
    expect(a.counts).toEqual({ low: 2, medium: 0, critical: 1 });
    expect(a.related).toEqual(["B"]);
    expect(b.related).toEqual(["A", "C"]);
    expect(describeEntitySummary(a)).toContain("2 low, 0 medium, 1 critical");
    expect(highestSeverity(a.counts)).toBe("critical");
    expect(highestSeverity(b.counts)).toBe("medium");
  });
});

describe("announcements", () => {
  it("caps at 250 characters", () => {
    const out = toAnnouncement("x".repeat(1000));
    expect(out.length).toBeLessThanOrEqual(MAX_ANNOUNCEMENT_LENGTH);
    expect(out.endsWith("…")).toBe(true);
    expect(toAnnouncement("y".repeat(250))).toHaveLength(250);
  });

  it("collapses whitespace and leaves short text intact", () => {
    expect(toAnnouncement("  a \n  b  ")).toBe("a b");
  });

  it("handles zero and singular counts", () => {
    expect(resultAnnouncement(0, 0)).toBe("0 entities, 0 anomalies");
    expect(resultAnnouncement(1, 1)).toBe("1 entity, 1 anomaly");
  });
});

describe("contrast", () => {
  it("computes known ratios", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrastRatio("#fff", "#fff")).toBeCloseTo(1, 5);
    expect(() => contrastRatio("zzz", "#fff")).toThrow();
  });

  it("applies 4.5 and 3 thresholds", () => {
    expect(meetsTextContrast("#777777", "#FFFFFF")).toBe(false);
    expect(meetsTextContrast("#777777", "#FFFFFF", true)).toBe(true);
    expect(meetsNonTextContrast("#CCCCCC", "#FFFFFF")).toBe(false);
  });
});

function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return "#" + [f(0), f(8), f(4)].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
}

const css = readFileSync(path.resolve(__dirname, "../../app/globals.css"), "utf8");
function token(name: string): string {
  const m = css.match(new RegExp(`--${name}:\\s*(\\d+(?:\\.\\d+)?)\\s+(\\d+(?:\\.\\d+)?)%\\s+(\\d+(?:\\.\\d+)?)%`));
  if (!m) throw new Error(`Missing CSS token --${name}`);
  return hslToHex(Number(m[1]), Number(m[2]), Number(m[3]));
}

describe("palette and focus contrast", () => {
  const bg = token("background");

  it.each([
    ["SLATE", SLATE],
    ["foreground", token("foreground")],
    ["muted-foreground", token("muted-foreground")],
    ["crimson token", token("crimson")],
  ])("%s meets 4.5:1 on the background", (_n, color) => {
    expect(meetsTextContrast(color, bg)).toBe(true);
  });

  it.each([
    ["CRIMSON", CRIMSON],
    ["SLATE", SLATE],
  ])("%s meets 3:1 as large text", (_n, color) => {
    expect(meetsTextContrast(color, bg, true)).toBe(true);
  });

  it("scene CRIMSON meets 3:1 non-text contrast on the background", () => {
    expect(meetsNonTextContrast(CRIMSON, bg)).toBe(true);
  });

  it("focus ring meets 3:1 against background and popover", () => {
    const ring = token("ring");
    expect(css).toMatch(/:focus-visible\s*{[^}]*outline:\s*2px solid hsl\(var\(--ring\)\)/);
    expect(meetsNonTextContrast(ring, bg)).toBe(true);
    expect(meetsNonTextContrast(ring, token("popover"))).toBe(true);
  });
});

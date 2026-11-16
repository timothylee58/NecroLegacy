import { describe, expect, it } from "vitest";
import { MockClient } from "./api-client";
import { FNB_DETERMINISTIC, FNB_ML, FNB_POINTS, FNB_ROT, FNB_SCHEMA } from "./mock-fnb";
import { FNB_EVENT_SCRIPT, MOCK_VISION } from "./mock-autopsy";
import { toSceneGraph } from "./session-reducer";

describe("F&B warehouse fixture", () => {
  it("marks the PJ-999 orphan hub and negative stock as critical", () => {
    const byName = Object.fromEntries(FNB_DETERMINISTIC.map((a) => [a.name, a]));
    expect(byName.orphan_foreign_key?.severity).toBe("critical");
    expect(byName.orphan_foreign_key?.sample_rows.every((r) => r.values.dest_hub_id === "PJ-999")).toBe(true);
    expect(byName.negative_stock?.severity).toBe("critical");
    expect(byName.negative_stock?.sample_rows.some((r) => r.values.qty_delta === "-00420")).toBe(true);
  });

  it("flags the zero-price rows as an ML outlier, not a critical rule", () => {
    const price = FNB_ML.anomalies.find((a) => a.entity === "POS_PRICE_TIER");
    expect(price?.source).toBe("ml");
    expect(price?.severity).toBe("medium");
    expect(price?.sample_rows[0]?.values.unit_price_myr).toBe("0000.00");
    expect(price?.outlier_scores?.[88]).toBe(-0.18);
  });

  it("keeps flagged scores below -0.15 and coordinates within -1..1", () => {
    for (const p of FNB_POINTS) {
      for (const c of [p.x, p.y, p.z]) expect(Math.abs(c)).toBeLessThanOrEqual(1);
      if (p.flagged) expect(p.outlier_score).toBeLessThan(-0.15);
      else expect(p.outlier_score).toBeGreaterThanOrEqual(-0.15);
    }
    expect(FNB_POINTS.filter((p) => p.entity === "MASTER_HUBS_MY")).toHaveLength(42);
  });

  it("draws only the dest_hub_id edge as critical", () => {
    const graph = toSceneGraph(FNB_SCHEMA, FNB_ML, FNB_ROT);
    const critical = graph.edges.filter((e) => e.critical);
    expect(critical).toHaveLength(1);
    expect(critical[0]).toMatchObject({ sourceId: "INV_LEDGER_94", targetId: "MASTER_HUBS_MY" });
  });

  it("puts the -420 delta to PJ-999 on the smudged manifest cell", () => {
    const smudged = MOCK_VISION.cells.find((c) => c.smudged);
    expect(smudged?.text).toBe("-420");
    expect(MOCK_VISION.cells.some((c) => c.text === "PJ-999")).toBe(true);
  });

  it("serves the F&B preset and scopes search to the session's dataset", async () => {
    const client = new MockClient();
    const { session_id } = await client.createSession({ kind: "preset", preset: "fnb_pos_corrupted" });
    expect((await client.search(session_id, "PJ-999")).hits.length).toBeGreaterThan(0);
    expect((await client.getAnomalies(session_id, { severity: "critical" })).map((a) => a.name).sort()).toEqual([
      "negative_stock",
      "orphan_foreign_key",
    ]);
    const ledger = await client.createSession({ kind: "preset", preset: "ledger_1994" });
    expect((await client.search(ledger.session_id, "PJ-999")).hits).toHaveLength(0);
    expect(FNB_EVENT_SCRIPT.at(-1)).toMatchObject({ type: "terminal", payload: { status: "completed" } });
  });
});

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { CoronersNotice, type CoronersNoticeProps } from "./CoronersNotice";
import { LEDGER_ENTITIES, LEDGER_ML, LEDGER_ROT } from "@/lib/mock-autopsy";

const base: CoronersNoticeProps = {
  phase: "running",
  sourceName: "1994 Mainframe Ledger Dump",
  currentNode: "rot_detector",
  rotStatus: "started",
  entities: LEDGER_ENTITIES,
  anomalies: LEDGER_ML.anomalies,
  servedFromCache: false,
};

const verdict = () => screen.getByRole("heading", { level: 2 }).textContent;

describe("CoronersNotice", () => {
  it("gives no verdict while rot detection is still running", () => {
    render(<CoronersNotice {...base} />);
    expect(verdict()).toMatch(/entities examined\./i);
    expect(verdict()).toMatch(/rot detection under way/i);
    expect(verdict()).not.toMatch(/no critical rot|critical\./i);
  });

  it("reports the critical count once rot detection completes", () => {
    const critical = LEDGER_ROT.anomalies.filter((a) => a.severity === "critical").length;
    expect(critical).toBeGreaterThan(0);
    render(
      <CoronersNotice
        {...base}
        rotStatus="completed"
        currentNode="api_resurrector"
        anomalies={[...LEDGER_ROT.anomalies, ...LEDGER_ML.anomalies]}
      />,
    );
    expect(verdict()).toMatch(new RegExp(`${critical} critical\\.`, "i"));
  });

  it("says so when rot detection failed instead of claiming there is no rot", () => {
    render(<CoronersNotice {...base} phase="failed" rotStatus="failed" />);
    expect(verdict()).toMatch(/rot detection failed/i);
    expect(verdict()).not.toMatch(/no critical rot/i);
  });

  it("treats a skipped rot step as finished", () => {
    render(<CoronersNotice {...base} rotStatus="skipped" anomalies={[]} />);
    expect(verdict()).toMatch(/no critical rot/i);
  });
});

import { forwardRef, useRef, useState, type ComponentProps } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Anomaly, Entity } from "@/types/autopsy";
import { NodeInspector } from "./NodeInspector";

const motionState = vi.hoisted(() => ({ reduced: false }));

// motion.div is replaced so the transition passed by SheetContent is observable in the DOM.
vi.mock("framer-motion", async () => {
  const actual = await vi.importActual<typeof import("framer-motion")>("framer-motion");
  const MotionDiv = forwardRef<HTMLDivElement, Record<string, unknown>>(function MotionDiv(props, ref) {
    const { initial, animate, exit, transition, ...rest } = props;
    void initial;
    void animate;
    void exit;
    return (
      <div
        ref={ref}
        data-duration={(transition as { duration?: number } | undefined)?.duration}
        {...(rest as ComponentProps<"div">)}
      />
    );
  });
  return {
    ...actual,
    motion: { ...actual.motion, div: MotionDiv },
    useReducedMotion: () => motionState.reduced,
  };
});

const entity: Entity = {
  name: "LEDGER_ENTRY",
  position_unit: "byte",
  fields: [
    { name: "ENTRY_ID", type: "integer", type_confidence: 0.9, start: 0, end: 8, length: 8, role: "identifier" },
    { name: "AMOUNT", type: "decimal", type_confidence: 0.9, start: 8, end: 20, length: 12, role: "amount" },
  ],
  primary_key: { field: "ENTRY_ID", confidence: 0.9 },
  foreign_keys: [],
  row_count: 1000,
  record_length: 20,
};

function makeAnomaly(rows: number[], overrides: Partial<Anomaly> = {}): Anomaly {
  return {
    id: "an-1",
    name: "orphan_foreign_key",
    entity: "LEDGER_ENTRY",
    field: "ENTRY_ID",
    affected_rows: rows,
    affected_row_count: rows.length,
    sample_rows: rows.map((r) => ({ row_number: r, values: { ENTRY_ID: `id-${r}`, AMOUNT: "1.00" } })),
    severity: "critical",
    confidence: 0.97,
    root_cause: "No matching parent.",
    source: "deterministic",
    ...overrides,
  };
}

function Harness({ anomalies }: { anomalies: Anomaly[] }) {
  const [open, setOpen] = useState(false);
  const openerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={openerRef} onClick={() => setOpen(true)}>
        open inspector
      </button>
      <NodeInspector
        entity={entity}
        anomalies={anomalies}
        open={open}
        onOpenChange={setOpen}
        opener={openerRef.current}
      />
    </>
  );
}

beforeEach(() => {
  motionState.reduced = false;
});

describe("NodeInspector", () => {
  it("moves focus into the dialog within 100 ms of opening (13.2)", async () => {
    const user = userEvent.setup();
    render(<Harness anomalies={[makeAnomaly([1, 2])]} />);
    const start = performance.now();
    await user.click(screen.getByRole("button", { name: "open inspector" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement), { timeout: 100 });
    expect(performance.now() - start).toBeLessThan(100 + 50);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
  });

  it("keeps Tab and Shift+Tab inside the dialog (13.3)", async () => {
    const user = userEvent.setup();
    render(<Harness anomalies={[makeAnomaly([1, 2])]} />);
    await user.click(screen.getByRole("button", { name: "open inspector" }));
    const dialog = await screen.findByRole("dialog");
    for (let i = 0; i < 6; i++) {
      await user.tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
    for (let i = 0; i < 6; i++) {
      await user.tab({ shift: true });
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
  });

  it("returns focus to the opener on Escape (13.4)", async () => {
    const user = userEvent.setup();
    render(<Harness anomalies={[makeAnomaly([1])]} />);
    const opener = screen.getByRole("button", { name: "open inspector" });
    await user.click(opener);
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });

  it("falls back to returnFocusRef when there is no opener (13.4)", async () => {
    const user = userEvent.setup();
    function CanvasHarness() {
      const [open, setOpen] = useState(true);
      const ref = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={ref}>canvas</button>
          <NodeInspector entity={entity} anomalies={[]} open={open} onOpenChange={setOpen} returnFocusRef={ref} />
        </>
      );
    }
    render(<CanvasHarness />);
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.getByRole("button", { name: "canvas" })).toHaveFocus());
  });

  it("names the dialog by entity and describes it with counts (13.5)", async () => {
    const user = userEvent.setup();
    render(<Harness anomalies={[makeAnomaly([1, 2]), makeAnomaly([3], { id: "an-2" })]} />);
    await user.click(screen.getByRole("button", { name: "open inspector" }));
    const dialog = await screen.findByRole("dialog", { name: "Entity: LEDGER_ENTRY" });
    expect(dialog).toHaveAccessibleDescription("2 fields, 1000 rows, 2 anomalies.");
  });

  it("shows at most 5 sample rows and the total when more exist (13.7)", async () => {
    const user = userEvent.setup();
    const rows = [1, 2, 3, 4, 5, 6, 7, 8];
    render(<Harness anomalies={[makeAnomaly(rows)]} />);
    await user.click(screen.getByRole("button", { name: "open inspector" }));
    const dialog = await screen.findByRole("dialog");
    const samples = within(dialog).getByRole("region", { name: "Sample corrupted rows" });
    expect(within(samples).getAllByRole("row")).toHaveLength(1 + 5);
    expect(within(samples).getByText("8 corrupted rows in total")).toBeInTheDocument();
  });

  it("omits the total line when 5 or fewer rows exist (13.7)", async () => {
    const user = userEvent.setup();
    render(<Harness anomalies={[makeAnomaly([1, 2, 3, 4, 5])]} />);
    await user.click(screen.getByRole("button", { name: "open inspector" }));
    await screen.findByRole("dialog");
    expect(screen.queryByText(/corrupted rows in total/)).not.toBeInTheDocument();
  });

  it("shows the empty-anomaly message when the entity has none (13.8)", async () => {
    const user = userEvent.setup();
    render(<Harness anomalies={[makeAnomaly([1], { entity: "OTHER" })]} />);
    await user.click(screen.getByRole("button", { name: "open inspector" }));
    await screen.findByRole("dialog");
    expect(screen.getByText("No anomalies were detected for this entity.")).toBeInTheDocument();
    expect(screen.queryByText("Sample corrupted rows")).not.toBeInTheDocument();
  });

  it.each([
    [false, "0.25"],
    [true, "0"],
  ])("uses the slide duration for reduced=%s (13.2)", async (reduced, duration) => {
    motionState.reduced = reduced;
    const user = userEvent.setup();
    render(<Harness anomalies={[makeAnomaly([1])]} />);
    await user.click(screen.getByRole("button", { name: "open inspector" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAttribute("data-duration", duration);
  });
});

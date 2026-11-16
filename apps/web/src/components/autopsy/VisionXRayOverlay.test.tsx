import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VisionXRayOverlay, overlayFillOpacity } from "./VisionXRayOverlay";
import type { VisionCell, VisionDefect } from "@/types/autopsy";

const bbox = (x: number) => ({ x, y: 10, width: 40, height: 12 });
const cell = (row: number, col: number, confidence: number, text = `t${row}${col}`): VisionCell => ({
  row,
  col,
  text,
  bbox: bbox(col * 50),
  confidence,
  smudged: false,
});

beforeEach(() => {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
});

function setup(cells: VisionCell[], defects: VisionDefect[] = []) {
  const onAnnounce = vi.fn();
  const utils = render(
    <VisionXRayOverlay
      imageUrl="/x.png"
      imageWidth={400}
      imageHeight={200}
      cells={cells}
      defects={defects}
      onAnnounce={onAnnounce}
    />,
  );
  return { onAnnounce, ...utils };
}

const toggle = () => screen.getByRole("button", { name: "Vision X-Ray" });

describe("overlayFillOpacity", () => {
  it("follows round(0.1 + 0.5 * (1 - c), 2)", () => {
    expect(overlayFillOpacity(1)).toBe(0.1);
    expect(overlayFillOpacity(0)).toBe(0.6);
    expect(overlayFillOpacity(0.6)).toBe(0.3);
    expect(overlayFillOpacity(0.8)).toBe(0.2);
  });

  it("is applied as fill-opacity on the main rect", () => {
    const { container } = setup([cell(1, 1, 0.8)]);
    const fills = [...container.querySelectorAll("rect")].map((r) => r.getAttribute("fill-opacity"));
    expect(fills).toContain("0.2");
  });
});

describe("flagged regions list", () => {
  it("does not flag confidence exactly 0.6", () => {
    setup([cell(1, 1, 0.6)]);
    expect(screen.getByText("No defects were detected.")).toBeInTheDocument();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("flags confidence below 0.6 and lists in cell order, then defect-only regions", () => {
    const defects: VisionDefect[] = [
      { type: "torn_total", row: 3, col: 1, bbox: bbox(10), confidence: 0.9 },
      { type: "smudged_digit", row: 2, col: 2, bbox: bbox(100), confidence: 0.7 },
    ];
    setup([cell(1, 1, 0.59, "abc"), cell(2, 2, 0.95, "smudge"), cell(4, 4, 0.9)], defects);
    const items = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual([
      "Row 1, column 1: abc, confidence 0.59, low confidence",
      "Row 2, column 2: smudge, confidence 0.95, smudged_digit",
      "Row 3, column 1: (no text), confidence 0.90, torn_total",
    ]);
    expect(screen.getByRole("heading", { name: "Flagged regions (3)" })).toBeInTheDocument();
  });

  it("draws crimson dashed rects for flagged cells and green solid for confident ones", () => {
    const { container } = setup([cell(1, 1, 0.3), cell(1, 2, 0.9)]);
    const mains = [...container.querySelectorAll("rect")].filter((r) => r.getAttribute("fill") !== "none");
    expect(mains[0]).toHaveAttribute("stroke", "#DC143C");
    expect(mains[0]).toHaveAttribute("stroke-dasharray");
    expect(mains[1]).toHaveAttribute("stroke", "#15803D");
    expect(mains[1]).not.toHaveAttribute("stroke-dasharray");
  });
});

describe("toggle", () => {
  it("is off by default and flips aria-pressed", async () => {
    const user = userEvent.setup();
    setup([cell(1, 1, 0.3)]);
    expect(toggle()).toHaveAttribute("aria-pressed", "false");
    await user.click(toggle());
    expect(toggle()).toHaveAttribute("aria-pressed", "true");
    await user.click(toggle());
    expect(toggle()).toHaveAttribute("aria-pressed", "false");
  });

  it("announces on and off with singular/plural region counts", async () => {
    const user = userEvent.setup();
    const one = setup([cell(1, 1, 0.3)]);
    await user.click(toggle());
    await user.click(toggle());
    expect(one.onAnnounce.mock.calls.map((c) => c[0])).toEqual([
      "Vision X-Ray on. 1 flagged region.",
      "Vision X-Ray off.",
    ]);
    one.unmount();

    const two = setup([cell(1, 1, 0.3), cell(1, 2, 0.2)]);
    await user.click(toggle());
    expect(two.onAnnounce).toHaveBeenCalledWith("Vision X-Ray on. 2 flagged regions.");
  });

  it("toggles with Enter and Space", async () => {
    const user = userEvent.setup();
    setup([cell(1, 1, 0.3)]);
    toggle().focus();
    await user.keyboard("{Enter}");
    expect(toggle()).toHaveAttribute("aria-pressed", "true");
    await user.keyboard(" ");
    expect(toggle()).toHaveAttribute("aria-pressed", "false");
  });
});

describe("disabled states", () => {
  it("is aria-disabled with a reason when there are no boxes, and does not toggle", async () => {
    const user = userEvent.setup();
    const { onAnnounce } = setup([]);
    expect(toggle()).toHaveAttribute("aria-disabled", "true");
    const reason = screen.getByText("Vision X-Ray is unavailable because no text regions were detected.");
    expect(toggle()).toHaveAttribute("aria-describedby", reason.id);
    await user.click(toggle());
    expect(toggle()).toHaveAttribute("aria-pressed", "false");
    expect(onAnnounce).not.toHaveBeenCalled();
  });

  it("is aria-disabled with a reason when the image fails to load", () => {
    setup([cell(1, 1, 0.3)]);
    expect(toggle()).not.toHaveAttribute("aria-disabled");
    fireEvent.error(screen.getByAltText("Uploaded legacy document"));
    expect(toggle()).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("Vision X-Ray is unavailable because the image failed to load.")).toBeInTheDocument();
  });
});

describe("keyboard activation of list items", () => {
  it("Enter and Space pin and unpin the region, showing its tooltip", async () => {
    const user = userEvent.setup();
    setup([cell(1, 1, 0.3, "abc")]);
    await user.click(toggle());
    const item = screen.getByRole("listitem");
    expect(item).toHaveAttribute("tabindex", "0");

    await user.tab();
    expect(item).toHaveFocus();
    expect(screen.getByRole("tooltip")).toHaveTextContent("abc");
    expect(screen.getByRole("tooltip")).toHaveTextContent("Confidence 0.30");
    await user.tab();
    expect(screen.queryByRole("tooltip")).toBeNull();

    await user.tab({ shift: true });
    await user.keyboard("{Enter}");
    await user.tab();
    expect(item).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("tooltip")).toBeInTheDocument();

    await user.tab({ shift: true });
    await user.keyboard(" ");
    await user.tab();
    expect(item).not.toHaveAttribute("aria-current");
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});

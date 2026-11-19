import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { LEDGER_SCHEMA } from "@/lib/mock-autopsy";
import { FNB_SCHEMA } from "@/lib/mock-fnb";
import type { RawPreview } from "@/types/autopsy";
import { RawDumpPanel } from "./RawDumpPanel";

const ebcdic: RawPreview = {
  records: [["ACCT0001", "00012500"], ["ACCT0002", "-0000700"]],
  line_delimiter: "LF",
  encoding: "ebcdic",
  encoding_confidence: 0.934,
  encoding_uncertain: true,
  field_delimiter: null,
  has_header: null,
  column_boundaries: [0, 10],
  errors: [{ line: 7, reason: "record shorter than first column boundary (10)" }],
};

describe("RawDumpPanel", () => {
  it("renders nothing without a preview (image input)", () => {
    const { container } = render(<RawDumpPanel preview={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("states what was detected for a fixed-width EBCDIC dump, without relying on colour", () => {
    render(<RawDumpPanel preview={ebcdic} />);
    expect(screen.getByText("EBCDIC (code page 037), decoded to UTF-8")).toBeInTheDocument();
    expect(screen.getByText("confidence 0.93")).toBeInTheDocument();
    expect(screen.getByText(/Uncertain: invalid bytes were replaced/)).toBeInTheDocument();
    expect(screen.getByText("none, fixed-width columns")).toBeInTheDocument();
    expect(screen.getByText("byte 0, 10")).toBeInTheDocument();
    expect(screen.getByText("1 line")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Parse errors" })).getByText(/line 7:/)).toBeInTheDocument();
  });

  it("shows records in a keyboard-scrollable, labelled table", () => {
    render(<RawDumpPanel preview={ebcdic} />);
    const region = screen.getByRole("region", { name: /First 2 records as parsed/ });
    expect(region).toHaveAttribute("tabindex", "0");
    const rows = within(region).getAllByRole("row");
    expect(rows).toHaveLength(1 + 2);
    expect(within(rows[0]!).getByRole("columnheader", { name: "@10" })).toBeInTheDocument();
    expect(within(rows[2]!).getByRole("cell", { name: "-0000700" })).toBeInTheDocument();
  });

  it("names the delimiter of the pipe-delimited F&B preset and hides column offsets", () => {
    const preview = FNB_SCHEMA.raw_preview;
    render(<RawDumpPanel preview={preview} />);
    expect(screen.getByText("pipe ( | )")).toBeInTheDocument();
    expect(screen.queryByText("Column offsets")).not.toBeInTheDocument();
    expect(screen.getByText("none")).toBeInTheDocument();
  });

  it("ships a real preview in the ledger mock", () => {
    expect(LEDGER_SCHEMA.raw_preview?.records.length).toBeGreaterThan(0);
  });
});

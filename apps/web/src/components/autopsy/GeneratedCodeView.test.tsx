import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ResurrectionResult } from "@/types/autopsy";
import { GeneratedCodeView } from "./GeneratedCodeView";

const base: ResurrectionResult = {
  source: "from fastapi import APIRouter\n\nrouter = APIRouter()\n# 日本語 \"quotes\"\n",
  syntax_ok: true,
  syntax_error: null,
  indexing: { status: "indexed", record_count: 1 },
  models: ["Customer"],
};

afterEach(() => vi.restoreAllMocks());

describe("GeneratedCodeView", () => {
  it("renders nothing when there is no source", () => {
    const { container } = render(<GeneratedCodeView resurrection={{ ...base, source: null }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("downloads a blob whose content equals the source, as a single .py file", async () => {
    let blob: Blob | undefined;
    vi.spyOn(URL, "createObjectURL").mockImplementation((b) => {
      blob = b as Blob;
      return "blob:x";
    });
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    let name = "";
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      name = this.download;
    });

    render(<GeneratedCodeView resurrection={base} />);
    await userEvent.setup().click(screen.getByRole("button", { name: /Download generated code/ }));

    expect(name).toBe("resurrected_api.py");
    expect(blob).toBeDefined();
    const text = await new Promise<string>((res) => {
      const r = new FileReader();
      r.onload = () => res(r.result as string);
      r.readAsText(blob as Blob);
    });
    expect(text).toBe(base.source);
    expect(revoke).toHaveBeenCalledWith("blob:x");
  });

  it("shows the syntax error location and still shows the source on failure", () => {
    render(
      <GeneratedCodeView
        resurrection={{
          ...base,
          source: "def (:\n",
          syntax_ok: false,
          syntax_error: { line: 1, offset: 5, message: "invalid syntax" },
        }}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("at line 1, column 5: invalid syntax");
    expect(screen.getByLabelText("Generated Python source, read-only")).toHaveTextContent("def (:");
  });
});

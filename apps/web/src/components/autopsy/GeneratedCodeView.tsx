"use client";
import { useId } from "react";
import type { ResurrectionResult } from "@/types/autopsy";

export interface GeneratedCodeViewProps {
  resurrection: ResurrectionResult | null;
  filename?: string;
}

export function GeneratedCodeView({
  resurrection,
  filename = "resurrected_api.py",
}: GeneratedCodeViewProps) {
  const headingId = useId();
  if (!resurrection || resurrection.source === null) return null;

  const { source, syntax_ok, syntax_error } = resurrection;

  function download() {
    const blob = new Blob([source as string], { type: "text/x-python;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 id={headingId} className="text-sm font-semibold">
          Generated FastAPI wrapper
        </h3>
        <button
          type="button"
          onClick={download}
          aria-label={`Download generated code as ${filename}`}
          className="rounded border px-2 py-1 text-xs hover:bg-muted focus-visible:outline focus-visible:outline-2"
        >
          Download .py
        </button>
      </div>
      {syntax_ok ? (
        <p className="text-xs" role="status">
          Syntax check passed.
        </p>
      ) : (
        <p role="alert" className="text-xs font-medium text-red-500">
          Syntax check failed
          {syntax_error
            ? ` at line ${syntax_error.line}${
                syntax_error.offset !== null ? `, column ${syntax_error.offset}` : ""
              }: ${syntax_error.message}`
            : "."}
        </p>
      )}
      <pre
        tabIndex={0}
        aria-label="Generated Python source, read-only"
        className="max-h-96 overflow-auto rounded bg-black/40 p-3 text-xs"
      >
        <code>{source}</code>
      </pre>
    </section>
  );
}

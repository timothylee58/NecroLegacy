"use client";
import { useId } from "react";
import { Check, Download, Ghost } from "lucide-react";
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
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 id={headingId} className="font-display text-3xl uppercase leading-none tracking-notice">
          Generated FastAPI wrapper
          {syntax_ok && (
            <span aria-hidden="true" className="ghost-rise ml-3 inline-block align-[-0.1em]">
              <Ghost className="h-7 w-7 text-tallow" strokeWidth={1.5} />
            </span>
          )}
        </h2>
        <button
          type="button"
          onClick={download}
          aria-label={`Download generated code as ${filename}`}
          className="inline-flex h-9 items-center gap-2 rounded border border-border px-3 text-xs font-semibold text-foreground transition-colors hover:border-tallow hover:text-tallow"
        >
          <Download aria-hidden="true" className="h-3.5 w-3.5" />
          Download generated code
        </button>
      </div>
      {syntax_ok ? (
        <p className="flex items-center gap-1.5 text-xs font-semibold text-verdigris" role="status">
          <Check aria-hidden="true" className="h-3.5 w-3.5" />
          Syntax check passed.
        </p>
      ) : (
        <p role="alert" className="text-xs font-semibold text-crimson-ink">
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
        className="max-h-[28rem] overflow-auto rounded border border-border bg-[hsl(36_14%_5%)] p-4 font-mono text-[0.78rem] leading-relaxed text-foreground/90"
      >
        <code>{source}</code>
      </pre>
    </section>
  );
}

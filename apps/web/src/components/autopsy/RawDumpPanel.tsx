import { useId } from "react";
import { CircleAlert } from "lucide-react";
import type { RawPreview } from "@/types/autopsy";

const ENCODING: Record<RawPreview["encoding"], string> = {
  ascii: "ASCII",
  "utf-8": "UTF-8",
  ebcdic: "EBCDIC (code page 037), decoded to UTF-8",
};

const LINE_DELIMITER: Record<RawPreview["line_delimiter"], string> = {
  LF: "LF",
  CRLF: "CRLF",
  CR: "CR",
  FIXED: "none, fixed-length records",
};

const FIELD_DELIMITER: Record<NonNullable<RawPreview["field_delimiter"]>, string> = {
  ",": "comma ( , )",
  ";": "semicolon ( ; )",
  "\t": "tab",
  "|": "pipe ( | )",
};

export function RawDumpPanel({ preview }: { preview: RawPreview | null | undefined }) {
  const headingId = useId();
  const tableLabelId = useId();
  if (!preview) return null;

  const width = Math.max(1, ...preview.records.map((r) => r.length));
  const columns = Array.from({ length: width }, (_, i) => i);
  const fixedWidth = preview.field_delimiter === null;

  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 id={headingId} className="font-display text-3xl uppercase leading-none tracking-notice">
          Raw dump
        </h2>
        <p className="text-xs text-muted-foreground">
          What the parser read before any inference, over the whole file.
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 border-y border-border py-3 text-sm sm:grid-cols-[repeat(auto-fit,minmax(9rem,1fr))]">
        <div className="min-w-0">
          <dt className="label">Encoding</dt>
          <dd className="mt-0.5">
            {ENCODING[preview.encoding]}
            <span className="block font-mono text-xs text-muted-foreground tabular">
              confidence {preview.encoding_confidence.toFixed(2)}
            </span>
            {preview.encoding_uncertain && (
              <span className="mt-0.5 flex items-center gap-1 text-xs font-semibold text-ochre">
                <CircleAlert aria-hidden="true" className="h-3.5 w-3.5" />
                Uncertain: invalid bytes were replaced
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt className="label">Line delimiter</dt>
          <dd className="mt-0.5">{LINE_DELIMITER[preview.line_delimiter]}</dd>
        </div>
        <div>
          <dt className="label">Field delimiter</dt>
          <dd className="mt-0.5">
            {fixedWidth ? "none, fixed-width columns" : FIELD_DELIMITER[preview.field_delimiter!]}
            {preview.has_header && (
              <span className="block text-xs text-muted-foreground">first record is a header</span>
            )}
          </dd>
        </div>
        {fixedWidth && (
          <div>
            <dt className="label">Column offsets</dt>
            <dd className="mt-0.5 font-mono tabular">
              {preview.column_boundaries.length > 0 ? `byte ${preview.column_boundaries.join(", ")}` : "none detected"}
            </dd>
          </div>
        )}
        <div>
          <dt className="label">Parse errors</dt>
          <dd className={preview.errors.length > 0 ? "mt-0.5 font-mono text-ochre tabular" : "mt-0.5 font-mono tabular"}>
            {preview.errors.length === 0 ? "none" : `${preview.errors.length} ${preview.errors.length === 1 ? "line" : "lines"}`}
          </dd>
        </div>
      </dl>

      {preview.errors.length > 0 && (
        <ul aria-label="Parse errors" className="flex max-h-32 flex-col overflow-y-auto font-mono text-xs text-muted-foreground">
          {preview.errors.slice(0, 20).map((e) => (
            <li key={`${e.line}:${e.reason}`}>
              line {e.line}: {e.reason}
            </li>
          ))}
        </ul>
      )}

      {preview.records.length === 0 ? (
        <p className="text-sm text-muted-foreground">No records could be read.</p>
      ) : (
        <div
          role="region"
          tabIndex={0}
          aria-labelledby={tableLabelId}
          className="max-h-80 overflow-auto border border-border bg-[hsl(36_14%_5%)]"
        >
          <table className="w-full whitespace-pre text-left font-mono text-xs">
            <caption id={tableLabelId} className="sr-only">
              First {preview.records.length} records as parsed, one column per detected field
            </caption>
            <thead className="sticky top-0 bg-muted text-muted-foreground">
              <tr>
                <th scope="col" className="px-2 py-1.5 font-medium">
                  #
                </th>
                {columns.map((c) => (
                  <th key={c} scope="col" className="px-2 py-1.5 font-medium">
                    {fixedWidth && preview.column_boundaries[c] !== undefined
                      ? `@${preview.column_boundaries[c]}`
                      : `field ${c + 1}`}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.records.map((record, i) => (
                <tr key={i} className="border-t border-border/60">
                  <th scope="row" className="px-2 py-1 font-normal text-muted-foreground tabular">
                    {i + 1}
                  </th>
                  {columns.map((c) => (
                    <td key={c} className="px-2 py-1 text-foreground/90">
                      {record[c] ?? ""}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-muted-foreground tabular">
        Showing the first {preview.records.length} records. Each record type is parsed again on its own before
        schema inference.
      </p>
    </section>
  );
}

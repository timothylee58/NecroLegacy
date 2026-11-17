"use client";
import { useMemo, useRef, type RefObject } from "react";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import type { Anomaly, Entity, SampleRow } from "@/types/autopsy";
import { SeverityBadge } from "./SeverityBadge";

const MAX_SAMPLES = 5;

export interface NodeInspectorProps {
  entity: Entity | null;
  anomalies: Anomaly[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Element that opened the drawer; focus returns here on close. */
  opener?: HTMLElement | null;
  /** Fallback for canvas picks, which have no DOM opener. */
  returnFocusRef?: RefObject<HTMLElement | null>;
}

function collectSamples(anomalies: Anomaly[]) {
  const seen = new Map<number, SampleRow>();
  const rows = new Set<number>();
  let reportedMax = 0;
  for (const a of anomalies) {
    reportedMax = Math.max(reportedMax, a.affected_row_count);
    a.affected_rows.forEach((r) => rows.add(r));
    for (const s of a.sample_rows) if (!seen.has(s.row_number)) seen.set(s.row_number, s);
  }
  // Anomalies may carry truncated affected_rows, so take the larger of the union and any reported count.
  const total = Math.max(rows.size, seen.size, reportedMax);
  return { samples: [...seen.values()].slice(0, MAX_SAMPLES), total };
}

export function NodeInspector({ entity, anomalies, open, onOpenChange, opener, returnFocusRef }: NodeInspectorProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const mine = useMemo(() => (entity ? anomalies.filter((a) => a.entity === entity.name) : []), [entity, anomalies]);
  const { samples, total } = useMemo(() => collectSamples(mine), [mine]);
  if (!entity) return null;

  const description = `${entity.fields.length} fields, ${entity.row_count} rows, ${mine.length} ${
    mine.length === 1 ? "anomaly" : "anomalies"
  }.`;
  const columns = entity.fields.map((f) => f.name);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        closeRef={closeRef}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          closeRef.current?.focus();
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          const target = opener?.isConnected ? opener : returnFocusRef?.current;
          target?.focus();
        }}
        className="w-full max-w-xl"
      >
        <SheetTitle>Entity: {entity.name}</SheetTitle>
        <SheetDescription className="mt-2 tabular">{description}</SheetDescription>

        <section aria-labelledby="ni-fields" className="mt-8">
          <h3 id="ni-fields" className="label">Fields</h3>
          <table className="mt-2 w-full text-left text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr className="border-b border-border">
                <th scope="col" className="py-1.5 pr-3 font-medium">Name</th>
                <th scope="col" className="py-1.5 pr-3 font-medium">Type</th>
                <th scope="col" className="py-1.5 font-medium">Range</th>
              </tr>
            </thead>
            <tbody>
              {entity.fields.map((f) => (
                <tr key={f.name} className="border-b border-border/60">
                  <th scope="row" className="py-1.5 pr-3 font-mono font-normal">{f.name}</th>
                  <td className="py-1.5 pr-3 font-mono text-muted-foreground">{f.type}</td>
                  <td className="py-1.5 font-mono text-muted-foreground">{f.start}–{f.end} ({entity.position_unit})</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {mine.length === 0 ? (
          <p className="mt-8 border-y border-border py-4 text-sm text-verdigris">No anomalies were detected for this entity.</p>
        ) : (
          <>
            <section aria-labelledby="ni-anomalies" className="mt-8">
              <h3 id="ni-anomalies" className="label">Anomalies</h3>
              <ul className="mt-2 flex flex-col border-t border-border">
                {mine.map((a) => (
                  <li key={a.id} className="border-b border-border py-3">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="font-display text-xl uppercase leading-tight tracking-notice">{a.name.replace(/_/g, " ")}</span>
                      <SeverityBadge severity={a.severity} />
                    </div>
                    <p className="mt-1 text-sm leading-relaxed">{a.root_cause}</p>
                    <p className="mt-1 font-mono text-xs text-muted-foreground">Confidence: {a.confidence.toFixed(2)}</p>
                  </li>
                ))}
              </ul>
            </section>

            <section aria-labelledby="ni-samples" className="mt-8">
              <h3 id="ni-samples" className="label">Sample corrupted rows</h3>
              <div role="group" tabIndex={0} aria-label="Sample rows, scrollable" className="mt-2 overflow-x-auto border border-border">
                <table className="w-full whitespace-nowrap text-left font-mono text-xs">
                  <thead className="bg-muted text-muted-foreground">
                    <tr>
                      <th scope="col" className="px-2 py-1.5 font-medium">Row</th>
                      {columns.map((c) => <th key={c} scope="col" className="px-2 py-1.5 font-medium">{c}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {samples.map((s) => (
                      <tr key={s.row_number} className="border-t border-border">
                        <th scope="row" className="px-2 py-1.5 font-normal text-crimson-ink">{s.row_number}</th>
                        {columns.map((c) => <td key={c} className="px-2 py-1.5">{s.values[c] ?? ""}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {total > MAX_SAMPLES && <p className="mt-2 text-xs text-muted-foreground tabular">{total} corrupted rows in total</p>}
            </section>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

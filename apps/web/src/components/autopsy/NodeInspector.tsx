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
        <SheetDescription>{description}</SheetDescription>

        <section aria-labelledby="ni-fields" className="mt-4">
          <h3 id="ni-fields" className="font-medium">Fields</h3>
          <table className="mt-1 w-full text-left text-sm">
            <thead>
              <tr><th scope="col">Name</th><th scope="col">Type</th><th scope="col">Range</th></tr>
            </thead>
            <tbody>
              {entity.fields.map((f) => (
                <tr key={f.name}>
                  <th scope="row" className="font-normal">{f.name}</th>
                  <td>{f.type}</td>
                  <td>{f.start}–{f.end} ({entity.position_unit})</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {mine.length === 0 ? (
          <p className="mt-4">No anomalies were detected for this entity.</p>
        ) : (
          <>
            <section aria-labelledby="ni-samples" className="mt-4">
              <h3 id="ni-samples" className="font-medium">Sample corrupted rows</h3>
              <div className="overflow-x-auto">
                <table className="mt-1 w-full text-left text-sm">
                  <thead>
                    <tr>
                      <th scope="col">Row</th>
                      {columns.map((c) => <th key={c} scope="col">{c}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {samples.map((s) => (
                      <tr key={s.row_number}>
                        <th scope="row" className="font-normal">{s.row_number}</th>
                        {columns.map((c) => <td key={c}>{s.values[c] ?? ""}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {total > MAX_SAMPLES && <p className="mt-1 text-sm">{total} corrupted rows in total</p>}
            </section>

            <section aria-labelledby="ni-anomalies" className="mt-4">
              <h3 id="ni-anomalies" className="font-medium">Anomalies</h3>
              <ul className="mt-1 flex flex-col gap-2">
                {mine.map((a) => (
                  <li key={a.id} className="rounded-md border p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{a.name.replace(/_/g, " ")}</span>
                      <SeverityBadge severity={a.severity} />
                    </div>
                    <p className="text-sm">Confidence: {a.confidence.toFixed(2)}</p>
                    <p className="text-sm">{a.root_cause}</p>
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

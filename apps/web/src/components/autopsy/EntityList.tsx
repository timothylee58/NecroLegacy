"use client";

import { useMemo } from "react";
import { highestSeverity, summarizeEntities } from "@/lib/a11y/summary";
import type { Anomaly, Entity } from "@/types/autopsy";
import { SeverityBadge } from "./SeverityBadge";

export interface EntityListProps {
  entities: Entity[];
  anomalies: Anomaly[];
  onOpen: (entityName: string, opener: HTMLButtonElement) => void;
}

export function EntityList({ entities, anomalies, onOpen }: EntityListProps) {
  const summaries = useMemo(() => summarizeEntities(entities, anomalies), [entities, anomalies]);
  return (
    <ul aria-label="Entities" className="flex flex-col gap-2">
      {summaries.map((s) => {
        const top = highestSeverity(s.counts);
        return (
          <li key={s.name}>
            <button
              type="button"
              aria-label={`${s.name}, ${top ?? "no anomalies"}`}
              onClick={(e) => onOpen(s.name, e.currentTarget)}
              className="flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              <span>{s.name}</span>{" "}
              {top ? <SeverityBadge severity={top} /> : <span>No anomalies</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

"use client";

import { useMemo } from "react";
import { ChevronRight } from "lucide-react";
import { highestSeverity, summarizeEntities } from "@/lib/a11y/summary";
import { cn } from "@/lib/utils";
import type { Anomaly, Entity } from "@/types/autopsy";
import { SeverityBadge } from "./SeverityBadge";

export interface EntityListProps {
  entities: Entity[];
  anomalies: Anomaly[];
  onOpen: (entityName: string, opener: HTMLButtonElement) => void;
  highlightedIds?: string[];
}

export function EntityList({ entities, anomalies, onOpen, highlightedIds = [] }: EntityListProps) {
  const summaries = useMemo(() => summarizeEntities(entities, anomalies), [entities, anomalies]);
  const rows = useMemo(() => new Map(entities.map((e) => [e.name, e.row_count])), [entities]);
  return (
    <ul aria-label="Entities" className="flex flex-col border-y border-border">
      {summaries.map((s) => {
        const top = highestSeverity(s.counts);
        const total = s.counts.low + s.counts.medium + s.counts.critical;
        const hit = highlightedIds.includes(s.name);
        return (
          <li key={s.name} className="relative border-t border-border first:border-t-0">
            <button
              type="button"
              aria-label={`${s.name}, ${top ?? "no anomalies"}`}
              onClick={(e) => onOpen(s.name, e.currentTarget)}
              className={cn(
                "group grid w-full grid-cols-[0.5rem_1fr_auto_1rem] items-start gap-x-3 px-1 pb-7 pt-3 text-left transition-colors hover:bg-accent",
                hit && "bg-tallow/10",
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "mt-1.5 h-2 w-2 rounded-full",
                  top === "critical" ? "bg-crimson" : top === "medium" ? "bg-ochre" : top === "low" ? "bg-formalin" : "bg-foreground/60",
                )}
              />
              <span className="truncate font-mono text-sm text-foreground">{s.name}</span>{" "}
              {top ? (
                <SeverityBadge severity={top} className="mt-0.5" />
              ) : (
                <span className="mt-0.5 text-xs font-semibold uppercase tracking-label text-muted-foreground">No anomalies</span>
              )}
              <ChevronRight
                aria-hidden="true"
                className="mt-0.5 h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
              />
            </button>
            {/* Outside the button so its visible text matches the required accessible name (18.5, WCAG 2.5.3). */}
            <span className="pointer-events-none absolute bottom-2.5 left-[1.625rem] right-8 truncate text-xs text-muted-foreground tabular">
              {(rows.get(s.name) ?? 0).toLocaleString("en-US")} rows · {total} {total === 1 ? "finding" : "findings"}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

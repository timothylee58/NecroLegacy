import { ChevronRight } from "lucide-react";
import { summarizeEntities } from "@/lib/a11y/summary";
import type { Anomaly, Entity } from "@/types/autopsy";
import { SeverityBadge } from "./SeverityBadge";

export interface AutopsySummaryProps {
  id?: string;
  entities: Entity[];
  anomalies: Anomaly[];
}

// Always rendered so the canvas aria-describedby target exists; the disclosure only affects visibility.
export function AutopsySummary({ id = "autopsy-summary", entities, anomalies }: AutopsySummaryProps) {
  const summaries = summarizeEntities(entities, anomalies);
  return (
    <details id={id} className="group border-t border-border pt-3">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden="true" className="h-4 w-4 transition-transform group-open:rotate-90" />
        Autopsy summary
      </summary>
      {summaries.length === 0 ? (
        <p className="mt-2 pl-6 text-sm text-muted-foreground">No specimens examined yet.</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-3 pl-6">
          {summaries.map((s) => (
            <li key={s.name} className="text-sm">
              <strong className="font-mono font-medium">{s.name}</strong>
              <span className="ml-3 inline-flex flex-wrap gap-x-4 gap-y-1">
                <SeverityBadge severity="low" count={s.counts.low} />
                <SeverityBadge severity="medium" count={s.counts.medium} />
                <SeverityBadge severity="critical" count={s.counts.critical} />
              </span>
              <span className="mt-0.5 block text-muted-foreground">
                Related entities: {s.related.length > 0 ? s.related.join(", ") : "none"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

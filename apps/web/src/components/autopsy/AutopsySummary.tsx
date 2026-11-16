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
    <details id={id} className="rounded-md border px-3 py-2">
      <summary className="cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
        Autopsy summary
      </summary>
      <ul className="mt-2 flex flex-col gap-2">
        {summaries.map((s) => (
          <li key={s.name}>
            <strong>{s.name}</strong>
            <span className="ml-2 inline-flex flex-wrap gap-3">
              <SeverityBadge severity="low" count={s.counts.low} />
              <SeverityBadge severity="medium" count={s.counts.medium} />
              <SeverityBadge severity="critical" count={s.counts.critical} />
            </span>
            <span className="block">Related entities: {s.related.length > 0 ? s.related.join(", ") : "none"}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

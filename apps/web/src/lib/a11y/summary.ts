import type { Anomaly, Entity, Severity } from "@/types/autopsy";

export const MAX_ANNOUNCEMENT_LENGTH = 250;

export interface EntitySummary {
  name: string;
  counts: Record<Severity, number>;
  related: string[];
}

export function summarizeEntities(entities: Entity[], anomalies: Anomaly[]): EntitySummary[] {
  const names = new Set(entities.map((e) => e.name));
  return entities.map((entity) => {
    const counts: Record<Severity, number> = { low: 0, medium: 0, critical: 0 };
    for (const a of anomalies) {
      if (a.entity === entity.name) counts[a.severity] += 1;
    }
    const related = new Set<string>();
    for (const fk of entity.foreign_keys) related.add(fk.target_entity);
    for (const other of entities) {
      if (other.name !== entity.name && other.foreign_keys.some((fk) => fk.target_entity === entity.name)) {
        related.add(other.name);
      }
    }
    related.delete(entity.name);
    return {
      name: entity.name,
      counts,
      related: [...related].filter((n) => names.has(n)).sort(),
    };
  });
}

export function describeEntitySummary(s: EntitySummary): string {
  const rel = s.related.length > 0 ? s.related.join(", ") : "none";
  return `${s.name}: ${s.counts.low} low, ${s.counts.medium} medium, ${s.counts.critical} critical anomalies. Related entities: ${rel}.`;
}

export function highestSeverity(counts: Record<Severity, number>): Severity | null {
  if (counts.critical > 0) return "critical";
  if (counts.medium > 0) return "medium";
  if (counts.low > 0) return "low";
  return null;
}

export function toAnnouncement(message: string): string {
  const text = message.replace(/\s+/g, " ").trim();
  if (text.length <= MAX_ANNOUNCEMENT_LENGTH) return text;
  return `${text.slice(0, MAX_ANNOUNCEMENT_LENGTH - 1).trimEnd()}…`;
}

export function resultAnnouncement(entityCount: number, anomalyCount: number): string {
  const e = `${entityCount} ${entityCount === 1 ? "entity" : "entities"}`;
  const a = `${anomalyCount} ${anomalyCount === 1 ? "anomaly" : "anomalies"}`;
  return toAnnouncement(`${e}, ${a}`);
}

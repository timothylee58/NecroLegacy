"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { summarizeEntities } from "@/lib/a11y/summary";
import type { Phase } from "@/lib/session-reducer";
import type { Anomaly, Entity, NodeName } from "@/types/autopsy";

const STEP_TITLE: Record<NodeName, string> = {
  vision_extractor: "vision extraction",
  schema_archaeologist: "schema archaeology",
  ml_rot_scorer: "outlier scoring",
  rot_detector: "rot detection",
  api_resurrector: "API resurrection",
};

export interface CoronersNoticeProps {
  phase: Phase;
  sourceName: string | null;
  currentNode: NodeName | null;
  entities: Entity[];
  anomalies: Anomaly[];
  servedFromCache: boolean;
}

interface Verdict {
  key: string;
  lines: Array<{ text: string; tone?: "crimson" | "dim" }>;
  detail: string;
}

function verdictOf({ phase, sourceName, currentNode, entities, anomalies, servedFromCache }: CoronersNoticeProps): Verdict {
  if (phase === "idle") {
    return {
      key: "idle",
      lines: [{ text: "Awaiting" }, { text: "a specimen.", tone: "dim" }],
      detail: "Open the intake to examine a legacy dump, a COBOL copybook or a scanned document.",
    };
  }
  const critical = anomalies.filter((a) => a.severity === "critical").length;
  const n = entities.length;
  if (n === 0) {
    const step = currentNode ? `Procedure under way: ${STEP_TITLE[currentNode]}.` : "Procedure under way.";
    return {
      key: `open:${phase}`,
      lines: [{ text: phase === "failed" ? "Autopsy halted." : "Case open." }, { text: sourceName ?? "Unnamed dump", tone: "dim" }],
      detail: phase === "failed" ? "The procedure stopped before any entity was recovered." : step,
    };
  }
  const worst = summarizeEntities(entities, anomalies)
    .map((s) => ({ name: s.name, critical: s.counts.critical, total: s.counts.low + s.counts.medium + s.counts.critical }))
    .sort((a, b) => b.critical - a.critical || b.total - a.total)[0];
  const cause = worst ? anomalies.find((a) => a.entity === worst.name && a.severity === "critical") ?? anomalies.find((a) => a.entity === worst.name) : undefined;
  const detail = [
    sourceName,
    worst && worst.total > 0 && cause
      ? `Worst specimen ${worst.name}: ${cause.name.replace(/_/g, " ")}, ${worst.total} ${worst.total === 1 ? "finding" : "findings"}.`
      : "No rot found in any specimen.",
    servedFromCache ? "Recalled from an earlier examination." : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    key: `result:${n}:${critical}:${anomalies.length}`,
    lines: [
      { text: `${n} ${n === 1 ? "entity" : "entities"} examined.` },
      critical > 0 ? { text: `${critical} critical.`, tone: "crimson" } : { text: "No critical rot.", tone: "dim" },
    ],
    detail,
  };
}

export function CoronersNotice(props: CoronersNoticeProps) {
  const reduced = useReducedMotion();
  const verdict = verdictOf(props);
  return (
    <section aria-label="Coroner's notice" className="relative">
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={verdict.key}
          initial={reduced ? false : { opacity: 0, y: 14, filter: "blur(6px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, y: -8, filter: "blur(4px)" }}
          transition={{ duration: reduced ? 0 : 0.45, ease: [0.16, 1, 0.3, 1] }}
        >
          <h2 className="notice text-[clamp(2.75rem,6.2vw,5.75rem)]">
            {verdict.lines.map((l) => (
              <span
                key={l.text}
                className={
                  l.tone === "crimson" ? "block text-crimson-ink" : l.tone === "dim" ? "block text-foreground/55" : "block"
                }
              >
                {l.text}
              </span>
            ))}
          </h2>
          <p className="mt-4 max-w-[68ch] text-sm leading-relaxed text-muted-foreground [text-wrap:pretty]">{verdict.detail}</p>
        </motion.div>
      </AnimatePresence>
    </section>
  );
}

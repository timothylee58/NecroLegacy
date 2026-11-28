"use client";

import type { CSSProperties } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { FlyingBat } from "./illustrations";
import { summarizeEntities } from "@/lib/a11y/summary";
import type { NodeStatus, Phase } from "@/lib/session-reducer";
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
  /** Critical findings come from rot_detector, so no verdict is given before it has finished. */
  rotStatus: NodeStatus;
  entities: Entity[];
  anomalies: Anomaly[];
  servedFromCache: boolean;
}

interface Verdict {
  key: string;
  lines: Array<{ text: string; tone?: "crimson" | "dim" }>;
  detail: string;
}

function verdictOf({
  phase,
  sourceName,
  currentNode,
  rotStatus,
  entities,
  anomalies,
  servedFromCache,
}: CoronersNoticeProps): Verdict {
  if (phase === "idle") {
    return {
      key: "idle",
      lines: [{ text: "Awaiting" }, { text: "a specimen.", tone: "dim" }],
      detail: "",
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
  const examined = { text: `${n} ${n === 1 ? "entity" : "entities"} examined.` };
  if (rotStatus !== "completed" && rotStatus !== "skipped") {
    // Before rot_detector reports, only ML outliers are known; "No critical rot" here would be a guess.
    const status =
      rotStatus === "failed" ? "Rot detection failed." : phase === "failed" ? "Autopsy halted." : "Rot detection under way.";
    return {
      key: `examining:${n}:${status}`,
      lines: [examined, { text: status, tone: "dim" }],
      detail: "",
    };
  }
  const worst = summarizeEntities(entities, anomalies)
    .map((s) => ({ name: s.name, critical: s.counts.critical, total: s.counts.low + s.counts.medium + s.counts.critical }))
    .sort((a, b) => b.critical - a.critical || b.total - a.total)[0];
  const cause = worst ? anomalies.find((a) => a.entity === worst.name && a.severity === "critical") ?? anomalies.find((a) => a.entity === worst.name) : undefined;
  const detail = [
    worst && worst.total > 0 && cause ? `Worst: ${worst.name} · ${cause.name.replace(/_/g, " ")}` : "No rot found.",
    servedFromCache ? "Recalled from cache." : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    key: `result:${n}:${critical}:${anomalies.length}`,
    lines: [
      examined,
      critical > 0 ? { text: `${critical} critical.`, tone: "crimson" } : { text: "No critical rot.", tone: "dim" },
    ],
    detail,
  };
}

const BURST = [
  { dx: "190px", dy: "-110px", delay: "0ms", size: "h-5 w-11" },
  { dx: "260px", dy: "-40px", delay: "120ms", size: "h-4 w-9" },
  { dx: "140px", dy: "-160px", delay: "240ms", size: "h-3 w-7" },
];

function BatBurst() {
  return (
    <span aria-hidden="true" className="pointer-events-none absolute right-0 top-1/2 motion-reduce:hidden">
      {BURST.map((b) => (
        <FlyingBat
          key={b.dx}
          className={`bat-burst -top-2 left-0 text-foreground/80 ${b.size}`}
          style={{ "--dx": b.dx, "--dy": b.dy, animationDelay: b.delay } as CSSProperties}
        />
      ))}
    </span>
  );
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
            {verdict.lines.map((l) =>
              l.tone === "crimson" ? (
                <span key={l.text} className="block text-crimson-ink">
                  <span className="relative inline-block">
                    {l.text}
                    <BatBurst />
                  </span>
                </span>
              ) : (
                <span key={l.text} className={l.tone === "dim" ? "block text-foreground/55" : "block"}>
                  {l.text}
                </span>
              ),
            )}
          </h2>
          {verdict.detail && (
            <p className="mt-4 max-w-[68ch] text-sm leading-relaxed text-muted-foreground [text-wrap:pretty]">{verdict.detail}</p>
          )}
        </motion.div>
      </AnimatePresence>
    </section>
  );
}

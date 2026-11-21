"use client";

import { useMemo } from "react";
import { Check, CircleDashed, Minus, X } from "lucide-react";
import { Candle } from "./illustrations";
import { cn } from "@/lib/utils";
import type { NodeName, NodeState, SessionEvent } from "@/types/autopsy";

export const NODE_ORDER: NodeName[] = [
  "vision_extractor",
  "schema_archaeologist",
  "ml_rot_scorer",
  "rot_detector",
  "api_resurrector",
];

const STATE_LABEL: Record<NodeState | "pending", string> = {
  pending: "pending",
  started: "running",
  completed: "completed",
  failed: "failed",
  skipped: "skipped",
};

// Roman numerals because the procedure order is fixed and the numbering carries meaning (product.md).
const STEP: Record<NodeName, { numeral: string; title: string }> = {
  vision_extractor: { numeral: "I", title: "Vision extraction" },
  schema_archaeologist: { numeral: "II", title: "Schema archaeology" },
  ml_rot_scorer: { numeral: "III", title: "Outlier scoring" },
  rot_detector: { numeral: "IV", title: "Rot detection" },
  api_resurrector: { numeral: "V", title: "API resurrection" },
};

const STATE_STYLE: Record<NodeState | "pending", { Icon: typeof Check; tone: string }> = {
  pending: { Icon: CircleDashed, tone: "text-muted-foreground" },
  started: { Icon: CircleDashed, tone: "text-tallow" },
  completed: { Icon: Check, tone: "text-verdigris" },
  failed: { Icon: X, tone: "text-crimson-ink" },
  skipped: { Icon: Minus, tone: "text-muted-foreground" },
};

export function ProgressRail({ events }: { events: SessionEvent[] }) {
  const { states, current } = useMemo(() => {
    const states: Partial<Record<NodeName, NodeState>> = {};
    let current: NodeName | null = null;
    for (const e of events) {
      if (e.type !== "node") continue;
      states[e.node] = e.state;
      if (e.state === "started") current = e.node;
    }
    return { states, current };
  }, [events]);

  return (
    <div>
      <ol aria-label="Pipeline progress" className="flex flex-col">
        {NODE_ORDER.map((node) => {
          const state = states[node] ?? "pending";
          const { Icon, tone } = STATE_STYLE[state];
          const step = STEP[node];
          const running = state === "started";
          return (
            <li
              key={node}
              title={step.title}
              aria-current={running ? "step" : undefined}
              className={cn(
                "grid grid-cols-[1.75rem_1fr_auto] items-center gap-x-2 border-t border-border py-2 first:border-t-0",
                running && "text-tallow",
              )}
            >
              <span aria-hidden="true" className="font-display text-lg leading-none text-muted-foreground">
                {step.numeral}
              </span>
              <span className="min-w-0 truncate font-mono text-xs">
                <span className={running ? "text-tallow" : "text-foreground"}>{node}</span>
                <span className={tone}>: {STATE_LABEL[state]}</span>
              </span>
              {running ? (
                <Candle className="h-5 w-3 text-tallow" />
              ) : (
                <Icon aria-hidden="true" className={cn("h-4 w-4", tone)} />
              )}
            </li>
          );
        })}
      </ol>
      <div aria-live="polite" aria-atomic="true" role="status" data-testid="current-node" className="sr-only">
        {current ?? ""}
      </div>
    </div>
  );
}

"use client";

import { useMemo } from "react";
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
      <ol aria-label="Pipeline progress" className="flex flex-wrap gap-3">
        {NODE_ORDER.map((node) => {
          const state = states[node] ?? "pending";
          return (
            <li key={node} aria-current={state === "started" ? "step" : undefined}>
              {node}: {STATE_LABEL[state]}
            </li>
          );
        })}
      </ol>
      <div aria-live="polite" aria-atomic="true" role="status" data-testid="current-node">
        {current ?? ""}
      </div>
    </div>
  );
}

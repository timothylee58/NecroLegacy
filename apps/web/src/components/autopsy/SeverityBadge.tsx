import { Info, Skull, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Severity } from "@/types/autopsy";

const CONFIG = {
  critical: { Icon: Skull, label: "Critical", tone: "text-crimson-ink" },
  medium: { Icon: TriangleAlert, label: "Medium", tone: "text-ochre" },
  low: { Icon: Info, label: "Low", tone: "text-formalin" },
} as const;

export function SeverityBadge({
  severity,
  count,
  className,
}: {
  severity: Severity;
  count?: number;
  className?: string;
}) {
  const { Icon, label, tone } = CONFIG[severity];
  const muted = count === 0;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-label",
        muted ? "text-muted-foreground" : tone,
        className,
      )}
    >
      <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" strokeWidth={2.25} />
      <span className="tabular">{count === undefined ? label : `${label}: ${count}`}</span>
    </span>
  );
}

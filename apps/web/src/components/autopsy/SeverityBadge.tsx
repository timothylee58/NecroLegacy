import { Info, ShieldAlert, TriangleAlert } from "lucide-react";
import type { Severity } from "@/types/autopsy";

const CONFIG = {
  critical: { Icon: ShieldAlert, label: "Critical" },
  medium: { Icon: TriangleAlert, label: "Medium" },
  low: { Icon: Info, label: "Low" },
} as const;

export function SeverityBadge({ severity, count }: { severity: Severity; count?: number }) {
  const { Icon, label } = CONFIG[severity];
  return (
    <span className="inline-flex items-center gap-1">
      <Icon aria-hidden="true" className="h-4 w-4" />
      <span>{count === undefined ? label : `${label}: ${count}`}</span>
    </span>
  );
}

"use client";

import { Button } from "@/components/ui/button";
import { AutopsySlab, FlyingBat } from "./illustrations";

export interface EmptyTableProps {
  busy: boolean;
  showIntake: boolean;
  onOpenIntake: () => void;
}

/** The slab before any specimen is recovered: idle, or while the first procedure steps run. */
export function EmptyTable({ busy, showIntake, onOpenIntake }: EmptyTableProps) {
  return (
    <div className="relative grid h-full place-items-center p-6">
      <p role="status" className="sr-only">
        {busy ? "Exhuming specimens…" : "The table is empty."}
      </p>
      {/* Two bats cross once when the theatre opens; the procedure, not the bats, signals progress. */}
      {!busy && (
        <>
          <FlyingBat className="bat-cross motion-reduce:hidden top-[16%] h-4 w-9 text-foreground/55" style={{ animationDelay: "700ms" }} />
          <FlyingBat className="bat-cross motion-reduce:hidden top-[25%] h-3 w-7 text-foreground/40" style={{ animationDelay: "1250ms" }} />
        </>
      )}
      <div className="flex w-full max-w-md flex-col items-center gap-5">
        <AutopsySlab className={busy ? "w-full text-foreground/55 animate-pulse motion-reduce:animate-none" : "w-full text-foreground/45"} />
        {showIntake && (
          <Button type="button" variant="outline" onClick={onOpenIntake}>
            Open the intake
          </Button>
        )}
      </div>
    </div>
  );
}

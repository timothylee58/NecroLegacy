"use client";
import { useCallback, useRef, useState } from "react";
import type { ChangeEvent, DragEvent, KeyboardEvent } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ArrowRight, BookOpen, CircleAlert, LoaderCircle, Receipt, ScrollText, type LucideIcon } from "lucide-react";
import { Coffin } from "./illustrations";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ApiRequestError, CREATE_SESSION_TIMEOUT_MS, type AutopsyClient, type SessionInput } from "@/lib/api-client";
import { getExtension, validateFile } from "@/lib/file-validation";
import type { CreateSessionResponse, PresetId } from "@/types/autopsy";

export interface DropzoneModalProps {
  client: AutopsyClient;
  onSession(response: CreateSessionResponse, input: SessionInput): void;
  open: boolean;
  onOpenChange(open: boolean): void;
}

export const PRESETS: ReadonlyArray<{ id: PresetId; label: string; Icon: LucideIcon }> = [
  { id: "ledger_1994", label: "1994 Mainframe Ledger Dump", Icon: BookOpen },
  { id: "fnb_pos_corrupted", label: "Corrupted F&B Warehouse POS Batch", Icon: Receipt },
  { id: "dotmatrix_manifest", label: "Faded Dot-Matrix Manifest", Icon: ScrollText },
];

// Past this, a waiting upload is most likely a cold start, so say so instead of leaving a bare "Uploading…".
const WAKING_AFTER_MS = 4_000;
const PAIRING_MESSAGE = "Select one data file, optionally with one .cpy copybook.";

type Failure = { kind: "rejected"; message: string } | { kind: "upload"; message: string };

export function DropzoneModal({ client, onSession, open, onOpenChange }: DropzoneModalProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const presetRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const lastInput = useRef<SessionInput | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const [waking, setWaking] = useState(false);
  const [focusIndex, setFocusIndex] = useState(0);
  const [selected, setSelected] = useState<PresetId | null>(null);
  const [dragging, setDragging] = useState(false);

  const upload = useCallback(
    async (input: SessionInput) => {
      lastInput.current = input;
      setFailure(null);
      setBusy(true);
      const wakingTimer = setTimeout(() => setWaking(true), WAKING_AFTER_MS);
      try {
        const response = await client.createSession(input);
        onSession(response, input);
        onOpenChange(false);
      } catch (err) {
        setFailure({
          kind: "upload",
          message:
            err instanceof ApiRequestError
              ? `Upload failed (${err.code}): ${err.message}`
              : `Upload failed: the service is unreachable or did not respond within ${CREATE_SESSION_TIMEOUT_MS / 1000} seconds.`,
        });
      } finally {
        clearTimeout(wakingTimer);
        setWaking(false);
        setBusy(false);
      }
    },
    [client, onSession, onOpenChange],
  );

  const handleFiles = useCallback(
    async (list: FileList | File[] | null) => {
      const files = list ? Array.from(list) : [];
      if (files.length === 0) return;
      for (const f of files) {
        const result = await validateFile(f);
        if (!result.ok) {
          setFailure({ kind: "rejected", message: `${f.name}: ${result.reason.message}` });
          return;
        }
      }
      const cpy = files.filter((f) => getExtension(f.name) === ".cpy");
      if (files.length === 1) {
        void upload({ kind: "file", file: files[0]! });
      } else if (files.length === 2 && cpy.length === 1) {
        void upload({ kind: "file", file: files.find((f) => f !== cpy[0])!, copybook: cpy[0] });
      } else {
        setFailure({ kind: "rejected", message: PAIRING_MESSAGE });
      }
    },
    [upload],
  );

  const openPicker = () => inputRef.current?.click();

  const onZoneKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openPicker();
    }
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    void handleFiles(e.dataTransfer.files);
  };

  const onInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    void handleFiles(e.target.files);
    e.target.value = "";
  };

  const selectPreset = (id: PresetId) => {
    setSelected(id);
    void upload({ kind: "preset", preset: id });
  };

  const onPresetKey = (e: KeyboardEvent<HTMLButtonElement>, index: number, id: PresetId) => {
    const last = PRESETS.length - 1;
    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = index === last ? 0 : index + 1;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = index === 0 ? last : index - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    if (next !== null) {
      e.preventDefault();
      setFocusIndex(next);
      presetRefs.current[next]?.focus();
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      selectPreset(id);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <div className="grid gap-2 pr-8">
          <DialogTitle>Begin an autopsy</DialogTitle>
          <DialogDescription className="sr-only">
            Drop a legacy dump, copybook or scan, or choose a built-in synthetic preset.
          </DialogDescription>
        </div>

        <div
          role="button"
          tabIndex={0}
          onClick={openPicker}
          onKeyDown={onZoneKey}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            setDragging(false);
            onDrop(e);
          }}
          className={cn(
            "grid cursor-pointer place-items-center gap-2 rounded border border-dashed px-6 py-8 text-center transition-colors",
            dragging ? "border-tallow bg-tallow/10" : "border-foreground/30 hover:border-tallow hover:bg-accent",
          )}
        >
          <Coffin className="h-10 w-7 text-tallow" />
          <span className="font-semibold">Drop files here or press Enter to browse</span>
          <span className="font-mono text-xs text-muted-foreground">
            .dat .txt .csv .cpy ≤ 5 MB · .png .jpg ≤ 10 MB
          </span>
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".dat,.txt,.csv,.cpy,.png,.jpg,.jpeg"
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onClick={(e) => e.stopPropagation()}
          onChange={onInputChange}
        />

        <div className="grid gap-2">
          <p id="preset-heading" className="label">
            Presets
          </p>
          <div role="radiogroup" aria-labelledby="preset-heading" className="grid border-y border-border">
            {PRESETS.map((p, i) => (
              <button
                key={p.id}
                ref={(el) => {
                  presetRefs.current[i] = el;
                }}
                type="button"
                role="radio"
                aria-label={p.label}
                aria-checked={selected === p.id}
                tabIndex={i === focusIndex ? 0 : -1}
                onFocus={() => setFocusIndex(i)}
                onClick={() => selectPreset(p.id)}
                onKeyDown={(e) => onPresetKey(e, i, p.id)}
                disabled={busy && selected !== p.id}
                className="group grid grid-cols-[auto_1fr_auto] items-center gap-x-4 border-t border-border px-1 py-3 text-left transition-colors first:border-t-0 hover:bg-accent aria-checked:bg-tallow/10"
              >
                <p.Icon aria-hidden="true" className="h-4 w-4 text-tallow/80" strokeWidth={1.75} />
                <span className="min-w-0 font-semibold">{p.label}</span>
                {busy && selected === p.id ? (
                  <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin text-tallow motion-reduce:animate-none" />
                ) : (
                  <ArrowRight
                    aria-hidden="true"
                    className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-tallow"
                  />
                )}
              </button>
            ))}
          </div>
        </div>

        {busy && (
          <p role="status" className="text-sm text-tallow">
            {waking ? "Waking the API. The first autopsy after a quiet spell takes about 20 seconds." : "Uploading…"}
          </p>
        )}
        {failure && (
          <div role="alert" className="grid gap-3 rounded border border-crimson/60 bg-crimson/10 p-3 text-sm">
            <p className="flex gap-2">
              <CircleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-crimson-ink" />
              <span>{failure.message}</span>
            </p>
            {failure.kind === "upload" && (
              <Button
                type="button"
                size="sm"
                className="justify-self-start"
                onClick={() => lastInput.current && void upload(lastInput.current)}
                disabled={busy}
              >
                Retry
              </Button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

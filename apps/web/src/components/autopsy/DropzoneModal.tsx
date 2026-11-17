"use client";
import { useCallback, useRef, useState } from "react";
import type { ChangeEvent, DragEvent, KeyboardEvent } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ArrowRight, CircleAlert, LoaderCircle, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ApiRequestError, type AutopsyClient, type SessionInput } from "@/lib/api-client";
import { getExtension, validateFile } from "@/lib/file-validation";
import type { CreateSessionResponse, PresetId } from "@/types/autopsy";

export interface DropzoneModalProps {
  client: AutopsyClient;
  onSession(response: CreateSessionResponse, input: SessionInput): void;
  open: boolean;
  onOpenChange(open: boolean): void;
}

export const PRESETS: ReadonlyArray<{ id: PresetId; label: string; meta: string }> = [
  { id: "ledger_1994", label: "1994 Mainframe Ledger Dump", meta: "mainframe_ledger_1994.dat · fixed-width ledger" },
  { id: "fnb_pos_corrupted", label: "Corrupted F&B Warehouse POS Batch", meta: "fnb_pos_corrupted_batch.txt · POS batch" },
  { id: "dotmatrix_manifest", label: "Faded Dot-Matrix Manifest", meta: "faded_dotmatrix_manifest.png · scanned manifest" },
];

const UPLOAD_TIMEOUT_MS = 10_000;
const PAIRING_MESSAGE = "Select one data file, optionally with one .cpy copybook.";

type Failure = { kind: "rejected"; message: string } | { kind: "upload"; message: string };

export function DropzoneModal({ client, onSession, open, onOpenChange }: DropzoneModalProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const presetRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const lastInput = useRef<SessionInput | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const [focusIndex, setFocusIndex] = useState(0);
  const [selected, setSelected] = useState<PresetId | null>(null);
  const [dragging, setDragging] = useState(false);

  const upload = useCallback(
    async (input: SessionInput) => {
      lastInput.current = input;
      setFailure(null);
      setBusy(true);
      try {
        const response = await client.createSession(input, AbortSignal.timeout(UPLOAD_TIMEOUT_MS));
        onSession(response, input);
        onOpenChange(false);
      } catch (err) {
        setFailure({
          kind: "upload",
          message:
            err instanceof ApiRequestError
              ? `Upload failed (${err.code}): ${err.message}`
              : "Upload failed: the service is unreachable or did not respond within 10 seconds.",
        });
      } finally {
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
          <DialogDescription className="max-w-[52ch] text-sm leading-relaxed">
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
          <Upload aria-hidden="true" className="h-5 w-5 text-tallow" />
          <span className="font-semibold">Drop files here or press Enter to browse</span>
          <span className="font-mono text-xs text-muted-foreground">
            Accepted: .dat .txt .csv .cpy up to 5 MB, .png .jpg .jpeg up to 10 MB
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
            Or open a synthetic case
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
                aria-describedby={`preset-${p.id}-meta`}
                aria-checked={selected === p.id}
                tabIndex={i === focusIndex ? 0 : -1}
                onFocus={() => setFocusIndex(i)}
                onClick={() => selectPreset(p.id)}
                onKeyDown={(e) => onPresetKey(e, i, p.id)}
                disabled={busy && selected !== p.id}
                className="group grid grid-cols-[1fr_auto] items-center gap-x-4 border-t border-border px-1 py-3 text-left transition-colors first:border-t-0 hover:bg-accent aria-checked:bg-tallow/10"
              >
                <span className="min-w-0">
                  <span className="block font-semibold">{p.label}</span>
                  <span id={`preset-${p.id}-meta`} className="block font-mono text-xs text-muted-foreground">
                    {p.meta}
                  </span>
                </span>
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
            Uploading…
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

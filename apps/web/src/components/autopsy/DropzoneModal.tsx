"use client";
import { useCallback, useRef, useState } from "react";
import type { ChangeEvent, DragEvent, KeyboardEvent } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { AutopsyClient, SessionInput } from "@/lib/api-client";
import { getExtension, validateFile } from "@/lib/file-validation";
import type { CreateSessionResponse, PresetId } from "@/types/autopsy";

export interface DropzoneModalProps {
  client: AutopsyClient;
  onSession(response: CreateSessionResponse, input: SessionInput): void;
  open: boolean;
  onOpenChange(open: boolean): void;
}

export const PRESETS: ReadonlyArray<{ id: PresetId; label: string }> = [
  { id: "ledger_1994", label: "1994 Mainframe Ledger Dump" },
  { id: "fnb_pos_corrupted", label: "Corrupted F&B Warehouse POS Batch" },
  { id: "dotmatrix_manifest", label: "Faded Dot-Matrix Manifest" },
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

  const upload = useCallback(
    async (input: SessionInput) => {
      lastInput.current = input;
      setFailure(null);
      setBusy(true);
      try {
        const response = await client.createSession(input, AbortSignal.timeout(UPLOAD_TIMEOUT_MS));
        onSession(response, input);
        onOpenChange(false);
      } catch {
        setFailure({
          kind: "upload",
          message: "Upload failed: the service is unreachable or did not respond within 10 seconds.",
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
        <DialogTitle>Begin an autopsy</DialogTitle>
        <DialogDescription>
          Drop a legacy dump, copybook or scan, or choose a built-in synthetic preset.
        </DialogDescription>

        <div
          role="button"
          tabIndex={0}
          aria-label="Upload files. Accepted extensions: .dat, .txt, .csv, .cpy, .png, .jpg, .jpeg. Press Enter or Space to choose files."
          onClick={openPicker}
          onKeyDown={onZoneKey}
          onDragOver={(e) => e.preventDefault()}
          onDrop={onDrop}
          className="rounded-md border-2 border-dashed border-border p-8 text-center"
        >
          Drop files here or press Enter to browse
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

        <div role="radiogroup" aria-label="Sample presets" className="grid gap-2">
          {PRESETS.map((p, i) => (
            <button
              key={p.id}
              ref={(el) => {
                presetRefs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={selected === p.id}
              tabIndex={i === focusIndex ? 0 : -1}
              onFocus={() => setFocusIndex(i)}
              onClick={() => selectPreset(p.id)}
              onKeyDown={(e) => onPresetKey(e, i, p.id)}
              className="rounded-md border border-border px-3 py-2 text-left aria-checked:border-primary"
            >
              {p.label}
            </button>
          ))}
        </div>

        {busy && (
          <p role="status" className="text-sm">
            Uploading…
          </p>
        )}
        {failure && (
          <div role="alert" className="grid gap-2 text-sm">
            <p>{failure.message}</p>
            {failure.kind === "upload" && (
              <Button
                type="button"
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

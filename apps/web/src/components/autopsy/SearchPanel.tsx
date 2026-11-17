"use client";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { AutopsyClient } from "@/lib/api-client";
import type { SearchHit } from "@/types/autopsy";
import { useAnnounce } from "./LiveAnnouncer";

export const MAX_QUERY_LENGTH = 500;

export interface SearchPanelProps {
  client: AutopsyClient;
  sessionId: string;
  onHits: (hits: SearchHit[]) => void;
}

type Status = "idle" | "loading" | "done" | "error";

export function SearchPanel({ client, sessionId, onHits }: SearchPanelProps) {
  const announce = useAnnounce();
  const inputId = useId();
  const errorId = useId();
  const [query, setQuery] = useState("");
  const [validation, setValidation] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (q.length < 1 || q.length > MAX_QUERY_LENGTH) {
      setValidation(`Query must be between 1 and ${MAX_QUERY_LENGTH} characters.`);
      return;
    }
    setValidation(null);
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setStatus("loading");
    try {
      const res = await client.search(sessionId, q, ctrl.signal);
      if (ctrl.signal.aborted) return;
      setHits(res.hits);
      setStatus("done");
      onHits(res.hits);
      announce(
        res.hits.length === 0
          ? "No records matched your query."
          : `${res.hits.length} ${res.hits.length === 1 ? "record" : "records"} matched.`,
      );
    } catch {
      if (ctrl.signal.aborted) return;
      setHits([]);
      setStatus("error");
      onHits([]);
      announce("Search failed.");
    }
  }

  return (
    <section aria-label="Search records" className="flex flex-col gap-4">
      <form onSubmit={submit} noValidate className="flex flex-col gap-2">
        <label htmlFor={inputId} className="font-display text-3xl uppercase leading-none tracking-notice">
          Search records
        </label>
        <p className="text-sm text-muted-foreground">Ask in plain words, for example: transfers with missing branch codes.</p>
        <div className="flex gap-2">
          <input
            id={inputId}
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (validation) setValidation(null);
            }}
            aria-invalid={validation ? true : undefined}
            aria-describedby={validation ? errorId : undefined}
            className="h-10 min-w-0 flex-1 rounded border border-border bg-slab px-3 text-sm text-foreground placeholder:text-muted-foreground hover:border-foreground/40 aria-[invalid=true]:border-crimson"
          />
          <button
            type="submit"
            disabled={status === "loading"}
            className="h-10 shrink-0 rounded bg-primary px-4 text-sm font-semibold text-primary-foreground transition-colors hover:bg-tallow disabled:opacity-60"
          >
            {status === "loading" ? "Searching…" : "Search"}
          </button>
        </div>
        {validation && (
          <p id={errorId} role="alert" className="text-sm text-crimson-ink">
            {validation}
          </p>
        )}
      </form>

      {status === "error" && <p role="alert" className="text-sm text-crimson-ink">Search failed. Try again.</p>}
      {status === "done" && hits.length === 0 && <p className="text-sm text-muted-foreground">No records matched.</p>}
      {status === "done" && hits.length > 0 && (
        <ul aria-label={`${hits.length} search results`} className="flex flex-col border-t border-border">
          {hits.map((h) => (
            <li key={`${h.entity}:${h.row_number}`} className="border-b border-border py-2.5">
              <div className="flex justify-between gap-3 text-sm">
                <span className="font-mono">
                  {h.entity}, row {h.row_number}
                </span>
                <span className="tabular text-muted-foreground">Similarity {h.similarity.toFixed(2)}</span>
              </div>
              <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{h.preview}</p>
              {h.anomaly_flags.length > 0 && (
                <p className="mt-1 text-xs font-semibold text-crimson-ink">Flags: {h.anomaly_flags.join(", ")}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

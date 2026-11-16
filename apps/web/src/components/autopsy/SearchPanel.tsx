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
    <section aria-label="Search records" className="flex flex-col gap-3">
      <form onSubmit={submit} noValidate className="flex flex-col gap-2">
        <label htmlFor={inputId} className="text-sm font-medium">
          Search records
        </label>
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
            className="flex-1 rounded-md border px-3 py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
          />
          <button
            type="submit"
            disabled={status === "loading"}
            className="rounded-md border px-3 py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            {status === "loading" ? "Searching…" : "Search"}
          </button>
        </div>
        {validation && (
          <p id={errorId} role="alert" className="text-sm">
            {validation}
          </p>
        )}
      </form>

      {status === "error" && <p role="alert">Search failed. Try again.</p>}
      {status === "done" && hits.length === 0 && <p>No records matched.</p>}
      {status === "done" && hits.length > 0 && (
        <ul aria-label={`${hits.length} search results`} className="flex flex-col gap-2">
          {hits.map((h) => (
            <li key={`${h.entity}:${h.row_number}`} className="rounded-md border px-3 py-2">
              <div className="flex justify-between gap-3 text-sm">
                <span>
                  {h.entity}, row {h.row_number}
                </span>
                <span>Similarity {h.similarity.toFixed(2)}</span>
              </div>
              <p className="truncate font-mono text-xs">{h.preview}</p>
              {h.anomaly_flags.length > 0 && (
                <p className="text-xs">Flags: {h.anomaly_flags.join(", ")}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

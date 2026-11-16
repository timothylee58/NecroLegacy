import type {
  Anomaly,
  CreateSessionResponse,
  PresetId,
  SearchHit,
  SearchResponse,
  SessionEvent,
  Severity,
} from "@/types/autopsy";
import { IMAGE_EVENT_SCRIPT, LEDGER_ANOMALIES, MOCK_IMAGE_DATA_URI, TEXT_EVENT_SCRIPT, playEvents } from "./mock-autopsy";
import type { SessionHandlers } from "./sse-client";

export type { SessionHandlers } from "./sse-client";

export type Unsubscribe = () => void;

export type SessionInput =
  | { kind: "text"; text: string }
  | { kind: "file"; file: File; copybook?: File }
  | { kind: "preset"; preset: PresetId };

export interface AnomalyFilter {
  severity?: Severity;
  entity?: string;
}

export interface AutopsyClient {
  createSession(input: SessionInput, signal?: AbortSignal): Promise<CreateSessionResponse>;
  subscribe(sessionId: string, handlers: SessionHandlers, lastEventId?: number): Unsubscribe;
  search(sessionId: string, query: string, signal?: AbortSignal): Promise<SearchResponse>;
  getAnomalies(sessionId: string, f?: AnomalyFilter): Promise<Anomaly[]>;
  presetImageUrl(id: PresetId): string;
}

const MOCK_STEP_MS = 400;

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

function isImageInput(input: SessionInput): boolean {
  if (input.kind === "preset") return input.preset === "dotmatrix_manifest";
  if (input.kind === "file") return input.file.type.startsWith("image/");
  return false;
}

export class MockClient implements AutopsyClient {
  private sessions = new Map<string, SessionEvent[]>();
  private counter = 0;

  async createSession(input: SessionInput, signal?: AbortSignal): Promise<CreateSessionResponse> {
    if (signal?.aborted) throw abortError();
    const image = isImageInput(input);
    this.counter += 1;
    const sessionId = `mock-session-${this.counter}`;
    this.sessions.set(sessionId, image ? IMAGE_EVENT_SCRIPT : TEXT_EVENT_SCRIPT);
    return { session_id: sessionId, input_kind: image ? "image" : "text", cached: false };
  }

  subscribe(sessionId: string, handlers: SessionHandlers, lastEventId = 0): Unsubscribe {
    const script = this.sessions.get(sessionId);
    if (!script) {
      handlers.onConnectionLost();
      return () => {};
    }
    // Only events with id > lastEventId are replayed, matching Last-Event-ID semantics.
    return playEvents(script, (e) => handlers.onEvent(e), { intervalMs: MOCK_STEP_MS, afterId: lastEventId });
  }

  async search(sessionId: string, query: string, signal?: AbortSignal): Promise<SearchResponse> {
    if (signal?.aborted) throw abortError();
    const q = query.trim().toLowerCase();
    if (!q || !this.sessions.has(sessionId)) return { hits: [] };

    const byRow = new Map<string, SearchHit>();
    for (const a of this.allAnomalies()) {
      for (const row of a.sample_rows) {
        const preview = Object.entries(row.values)
          .map(([k, v]) => `${k}=${v}`)
          .join(" ");
        const haystack = `${a.entity} ${a.name} ${a.root_cause} ${preview}`.toLowerCase();
        if (!haystack.includes(q)) continue;
        const key = `${a.entity}:${row.row_number}`;
        const existing = byRow.get(key);
        if (existing) {
          if (!existing.anomaly_flags.includes(a.name)) existing.anomaly_flags.push(a.name);
        } else {
          byRow.set(key, {
            entity: a.entity,
            row_number: row.row_number,
            similarity: haystack.startsWith(q) ? 1 : 0.8,
            anomaly_flags: [a.name],
            preview,
          });
        }
      }
    }
    return { hits: [...byRow.values()].sort((x, y) => y.similarity - x.similarity) };
  }

  async getAnomalies(sessionId: string, f: AnomalyFilter = {}): Promise<Anomaly[]> {
    if (!this.sessions.has(sessionId)) return [];
    return this.allAnomalies().filter(
      (a) => (!f.severity || a.severity === f.severity) && (!f.entity || a.entity === f.entity),
    );
  }

  presetImageUrl(_id: PresetId): string {
    return MOCK_IMAGE_DATA_URI;
  }

  private allAnomalies(): Anomaly[] {
    return [...LEDGER_ANOMALIES.deterministic, ...LEDGER_ANOMALIES.ml];
  }
}

export function createClient(): AutopsyClient {
  if (process.env.NEXT_PUBLIC_USE_MOCK === "true") return new MockClient();
  throw new Error("HTTP AutopsyClient is not implemented yet (task 24.1); set NEXT_PUBLIC_USE_MOCK=true.");
}

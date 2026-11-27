import type {
  Anomaly,
  CreateSessionResponse,
  ErrorResponse,
  PresetId,
  SearchHit,
  SearchResponse,
  SessionEvent,
  Severity,
} from "@/types/autopsy";
import {
  FNB_DATASET,
  FNB_EVENT_SCRIPT,
  IMAGE_EVENT_SCRIPT,
  LEDGER_DATASET,
  MOCK_IMAGE_DATA_URI,
  TEXT_EVENT_SCRIPT,
  playEvents,
  type MockDataset,
} from "./mock-autopsy";
import { openSessionStream, type SessionHandlers } from "./sse-client";

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
  /** Starts the API waking from scale-to-zero without waiting for it. */
  wake?(): void;
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

function mockSessionFor(input: SessionInput): { script: SessionEvent[]; dataset: MockDataset } {
  if (isImageInput(input)) return { script: IMAGE_EVENT_SCRIPT, dataset: FNB_DATASET };
  if (input.kind === "preset" && input.preset === "fnb_pos_corrupted") {
    return { script: FNB_EVENT_SCRIPT, dataset: FNB_DATASET };
  }
  return { script: TEXT_EVENT_SCRIPT, dataset: LEDGER_DATASET };
}

interface MockSession {
  script: SessionEvent[];
  dataset: MockDataset;
}

export class MockClient implements AutopsyClient {
  private sessions = new Map<string, MockSession>();
  private counter = 0;

  async createSession(input: SessionInput, signal?: AbortSignal): Promise<CreateSessionResponse> {
    if (signal?.aborted) throw abortError();
    const image = isImageInput(input);
    this.counter += 1;
    const sessionId = `mock-session-${this.counter}`;
    this.sessions.set(sessionId, mockSessionFor(input));
    return { session_id: sessionId, input_kind: image ? "image" : "text", cached: false };
  }

  subscribe(sessionId: string, handlers: SessionHandlers, lastEventId = 0): Unsubscribe {
    const script = this.sessions.get(sessionId)?.script;
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
    const anomalies = this.anomaliesFor(sessionId);

    const byRow = new Map<string, SearchHit>();
    for (const a of anomalies) {
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
    return this.anomaliesFor(sessionId).filter(
      (a) => (!f.severity || a.severity === f.severity) && (!f.entity || a.entity === f.entity),
    );
  }

  presetImageUrl(_id: PresetId): string {
    return MOCK_IMAGE_DATA_URI;
  }

  private anomaliesFor(sessionId: string): Anomaly[] {
    return this.sessions.get(sessionId)?.dataset.rot.anomalies ?? [];
  }
}

export const REQUEST_TIMEOUT_MS = 10_000;
// Starting a session is the first call after a quiet spell, and Cloud Run then cold-starts the API (measured 19 to
// 22 s from instance start to ready). Every later call reaches a warm instance and keeps the 10 s limit.
export const CREATE_SESSION_TIMEOUT_MS = 45_000;

export class ApiRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

// setTimeout rather than AbortSignal.timeout so the deadline is controllable with fake timers.
function withTimeout(signal: AbortSignal | undefined, ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("Request timed out", "TimeoutError")), ms);
  return {
    signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    clear: () => clearTimeout(timer),
  };
}

async function toError(res: Response): Promise<ApiRequestError> {
  try {
    const body = (await res.json()) as Partial<ErrorResponse>;
    if (body.error && typeof body.error.code === "string") {
      return new ApiRequestError(body.error.code, body.error.message ?? res.statusText, res.status);
    }
  } catch {
    // Non-JSON error bodies fall through to the generic mapping.
  }
  return new ApiRequestError("http_error", `Request failed with status ${res.status}.`, res.status);
}

export class HttpClient implements AutopsyClient {
  private readonly base: string;

  constructor(baseUrl = process.env.NEXT_PUBLIC_API_URL ?? "") {
    this.base = baseUrl.replace(/\/+$/, "");
  }

  private async request(
    path: string,
    init: RequestInit,
    signal?: AbortSignal,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<Response> {
    const timeout = withTimeout(signal, timeoutMs);
    try {
      const res = await fetch(`${this.base}${path}`, { ...init, signal: timeout.signal });
      if (!res.ok) throw await toError(res);
      return res;
    } finally {
      timeout.clear();
    }
  }

  async createSession(input: SessionInput, signal?: AbortSignal): Promise<CreateSessionResponse> {
    let res: Response;
    if (input.kind === "preset") {
      res = await this.request(
        "/api/sessions/preset",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ preset_id: input.preset }),
        },
        signal,
        CREATE_SESSION_TIMEOUT_MS,
      );
    } else {
      const form = new FormData();
      if (input.kind === "text") {
        form.append("file", new File([input.text], "pasted.dat", { type: "text/plain" }));
      } else {
        form.append("file", input.file, input.file.name);
        if (input.copybook) form.append("copybook", input.copybook, input.copybook.name);
      }
      res = await this.request("/api/sessions", { method: "POST", body: form }, signal, CREATE_SESSION_TIMEOUT_MS);
    }
    return (await res.json()) as CreateSessionResponse;
  }

  wake(): void {
    // Fire and forget: the answer does not matter, only that a request reaches Cloud Run while the user is still
    // choosing a file, so the first real call finds a warm instance.
    fetch(`${this.base}/api/health`, { method: "GET", cache: "no-store" }).catch(() => {});
  }

  subscribe(sessionId: string, handlers: SessionHandlers, lastEventId = 0): Unsubscribe {
    return openSessionStream(`${this.base}/api/sessions/${encodeURIComponent(sessionId)}/events`, lastEventId, handlers);
  }

  async search(sessionId: string, query: string, signal?: AbortSignal): Promise<SearchResponse> {
    const res = await this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/search`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query }) },
      signal,
    );
    return (await res.json()) as SearchResponse;
  }

  async getAnomalies(sessionId: string, f: AnomalyFilter = {}): Promise<Anomaly[]> {
    const params = new URLSearchParams();
    if (f.severity) params.set("severity", f.severity);
    if (f.entity) params.set("entity", f.entity);
    const qs = params.size > 0 ? `?${params.toString()}` : "";
    const res = await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/anomalies${qs}`, { method: "GET" });
    return ((await res.json()) as { anomalies: Anomaly[] }).anomalies;
  }

  presetImageUrl(id: PresetId): string {
    return `${this.base}/api/presets/${encodeURIComponent(id)}/image`;
  }
}

export function createClient(): AutopsyClient {
  return process.env.NEXT_PUBLIC_USE_MOCK === "true" ? new MockClient() : new HttpClient();
}

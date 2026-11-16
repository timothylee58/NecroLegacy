import type { SessionEvent } from "@/types/autopsy";

export interface SessionHandlers {
  onEvent(e: SessionEvent): void;
  onReconnecting(attempt: number, delayMs: number): void;
  onConnectionLost(): void;
}

export const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000] as const;

interface Frame {
  id?: number;
  event?: string;
  data: string;
}

export class SseFrameParser {
  private buffer = "";
  private id: string | undefined;
  private event: string | undefined;
  private data: string[] = [];
  push(chunk: string): Frame[] {
    this.buffer += chunk;
    const frames: Frame[] = [];
    for (;;) {
      const m = /\r\n|\n|\r/.exec(this.buffer);
      if (!m) break;
      // A lone trailing "\r" may be the first half of a CRLF split across chunks.
      if (m[0] === "\r" && m.index === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, m.index);
      this.buffer = this.buffer.slice(m.index + m[0].length);
      const frame = this.line(line);
      if (frame) frames.push(frame);
    }
    return frames;
  }

  private line(line: string): Frame | null {
    if (line === "") {
      const hasFields = this.data.length > 0 || this.event !== undefined || this.id !== undefined;
      if (!hasFields) return null;
      const frame: Frame = {
        id: this.id !== undefined && /^\d+$/.test(this.id) ? Number(this.id) : undefined,
        event: this.event,
        data: this.data.join("\n"),
      };
      this.id = undefined;
      this.event = undefined;
      this.data = [];
      return frame;
    }
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "id") this.id = value;
    else if (field === "event") this.event = value;
    else if (field === "data") this.data.push(value);
    return null;
  }
}

export function openSessionStream(
  url: string,
  lastEventId: number,
  handlers: SessionHandlers,
): () => void {
  const controller = new AbortController();
  let last = lastEventId;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const finish = () => {
    closed = true;
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  };

  const handleFrame = (frame: Frame): boolean => {
    if (frame.data === "") return false;
    let event: SessionEvent;
    try {
      event = JSON.parse(frame.data) as SessionEvent;
    } catch {
      return false;
    }
    const id = frame.id ?? event.id;
    if (typeof id !== "number" || id <= last) return false;
    last = id;
    handlers.onEvent(event);
    return event.type === "terminal";
  };

  const fail = () => {
    if (closed) return;
    failures += 1;
    if (failures > RETRY_DELAYS_MS.length) {
      closed = true;
      handlers.onConnectionLost();
      return;
    }
    const delay = RETRY_DELAYS_MS[failures - 1]!;
    handlers.onReconnecting(failures, delay);
    timer = setTimeout(() => void connect(), delay);
  };

  const connect = async (): Promise<void> => {
    if (closed) return;
    try {
      const res = await fetch(url, {
        headers: { Accept: "text/event-stream", "Last-Event-ID": String(last) },
        signal: controller.signal,
        cache: "no-store",
      });
      if (!res.ok || !res.body) throw new Error(`SSE status ${res.status}`);
      failures = 0;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseFrameParser();
      for (;;) {
        const { done, value } = await reader.read();
        if (closed) return;
        if (done) break;
        for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
          if (handleFrame(frame)) {
            finish();
            return;
          }
        }
      }
      fail();
    } catch {
      fail();
    }
  };

  void connect();
  return finish;
}

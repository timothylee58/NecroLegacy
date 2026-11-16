import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openSessionStream, RETRY_DELAYS_MS, type SessionHandlers } from "./sse-client";
import type { SessionEvent } from "@/types/autopsy";

const enc = new TextEncoder();

function frame(id: number, type: "error" | "terminal" = "error"): string {
  const payload =
    type === "terminal"
      ? { status: "completed" }
      : { node: "rot_detector", code: "X", message: "m" };
  return `id: ${id}\ndata: ${JSON.stringify({ id, type, payload })}\n\n`;
}

function streamResponse(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

function makeHandlers() {
  const events: SessionEvent[] = [];
  const handlers: SessionHandlers = {
    onEvent: vi.fn((e: SessionEvent) => void events.push(e)),
    onReconnecting: vi.fn(),
    onConnectionLost: vi.fn(),
  };
  return { events, handlers };
}

describe("openSessionStream", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("retries with 1, 2, 4, 8, 16 s delays then reports connection lost", async () => {
    fetchMock.mockRejectedValue(new Error("down"));
    const { handlers } = makeHandlers();
    openSessionStream("/s", 0, handlers);

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const expected = [1000, 2000, 4000, 8000, 16000];
    expect([...RETRY_DELAYS_MS]).toEqual(expected);

    for (let i = 0; i < expected.length; i++) {
      expect(handlers.onReconnecting).toHaveBeenLastCalledWith(i + 1, expected[i]);
      await vi.advanceTimersByTimeAsync(expected[i]! - 1);
      expect(fetchMock).toHaveBeenCalledTimes(i + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchMock).toHaveBeenCalledTimes(i + 2);
    }

    expect(handlers.onReconnecting).toHaveBeenCalledTimes(5);
    expect(handlers.onConnectionLost).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(handlers.onConnectionLost).toHaveBeenCalledTimes(1);
  });

  it("treats a non-ok response as a failure", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));
    const { handlers } = makeHandlers();
    openSessionStream("/s", 0, handlers);
    await vi.advanceTimersByTimeAsync(0);
    expect(handlers.onReconnecting).toHaveBeenCalledWith(1, 1000);
  });

  it("resumes from the last event id and delivers no duplicates", async () => {
    fetchMock
      .mockResolvedValueOnce(streamResponse([frame(1), frame(2)]))
      .mockResolvedValueOnce(streamResponse([frame(2), frame(3), frame(3), frame(4, "terminal")]));
    const { handlers, events } = makeHandlers();
    openSessionStream("/s", 0, handlers);

    await vi.advanceTimersByTimeAsync(0);
    expect(events.map((e) => e.id)).toEqual([1, 2]);
    expect(handlers.onReconnecting).toHaveBeenCalledWith(1, 1000);

    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const headers = fetchMock.mock.calls[1]![1].headers as Record<string, string>;
    expect(headers["Last-Event-ID"]).toBe("2");
    expect(events.map((e) => e.id)).toEqual([1, 2, 3, 4]);
    expect(handlers.onConnectionLost).not.toHaveBeenCalled();
  });

  it("ignores events at or below the initial lastEventId", async () => {
    fetchMock.mockResolvedValueOnce(streamResponse([frame(5), frame(6), frame(7, "terminal")]));
    const { handlers, events } = makeHandlers();
    openSessionStream("/s", 5, handlers);
    await vi.advanceTimersByTimeAsync(0);
    expect(events.map((e) => e.id)).toEqual([6, 7]);
    const headers = fetchMock.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers["Last-Event-ID"]).toBe("5");
  });

  it("resets the backoff after a successful connection", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("down"))
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce(streamResponse([frame(1)]))
      .mockRejectedValue(new Error("down"));
    const { handlers } = makeHandlers();
    openSessionStream("/s", 0, handlers);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(handlers.onReconnecting).toHaveBeenLastCalledWith(1, 1000);
  });

  it("stops retrying after close()", async () => {
    fetchMock.mockRejectedValue(new Error("down"));
    const { handlers } = makeHandlers();
    const close = openSessionStream("/s", 0, handlers);
    await vi.advanceTimersByTimeAsync(0);
    close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(handlers.onConnectionLost).not.toHaveBeenCalled();
  });
});

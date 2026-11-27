import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError, HttpClient, createClient, MockClient } from "./api-client";

const BASE = "http://api.test";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("HttpClient", () => {
  it("uploads a file and copybook as multipart form data", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(json({ session_id: "s1", input_kind: "text", cached: false }, 201));
    const file = new File(["abc"], "a.dat");
    const copybook = new File(["01 X."], "a.cpy");
    const res = await new HttpClient(BASE).createSession({ kind: "file", file, copybook });
    expect(res.session_id).toBe("s1");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/api/sessions`);
    expect(init?.method).toBe("POST");
    const form = init?.body as FormData;
    expect((form.get("file") as File).name).toBe("a.dat");
    expect((form.get("copybook") as File).name).toBe("a.cpy");
  });

  it("posts presets as JSON", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(json({ session_id: "s2", input_kind: "image", cached: true }, 201));
    await new HttpClient(BASE).createSession({ kind: "preset", preset: "dotmatrix_manifest" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/api/sessions/preset`);
    expect(JSON.parse(init?.body as string)).toEqual({ preset_id: "dotmatrix_manifest" });
  });

  it("maps ErrorResponse bodies to ApiRequestError", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json({ error: { code: "file_too_large", message: "Too big." } }, 413),
    );
    const err = await new HttpClient(BASE)
      .createSession({ kind: "file", file: new File(["x"], "a.dat") })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err).toMatchObject({ code: "file_too_large", message: "Too big.", status: 413 });
  });

  it("maps non-JSON failures to a generic error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("boom", { status: 502 }));
    await expect(new HttpClient(BASE).search("s", "q")).rejects.toMatchObject({ code: "http_error", status: 502 });
  });

  const hang = () =>
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        }),
    );

  it("aborts a search after 10 seconds", async () => {
    vi.useFakeTimers();
    hang();
    const pending = new HttpClient(BASE).search("s", "q").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await pending).toMatchObject({ name: "TimeoutError" });
  });

  it("gives session creation 45 seconds so a cold start does not fail the first click", async () => {
    vi.useFakeTimers();
    hang();
    let settled: unknown = "pending";
    const pending = new HttpClient(BASE)
      .createSession({ kind: "preset", preset: "ledger_1994" })
      .catch((e: unknown) => e)
      .then((v) => (settled = v));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(settled).toBe("pending");
    await vi.advanceTimersByTimeAsync(15_001);
    await pending;
    expect(settled).toMatchObject({ name: "TimeoutError" });
  });

  it("wake pings the health endpoint and ignores failures", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("offline"));
    expect(() => new HttpClient(BASE).wake()).not.toThrow();
    expect(fetchMock.mock.calls[0]![0]).toBe(`${BASE}/api/health`);
    await Promise.resolve();
  });

  it("sends the search request as a JSON POST", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ hits: [] }));
    await new HttpClient(BASE).search("a b", "orphan keys");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/api/sessions/a%20b/search`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ query: "orphan keys" });
  });

  it("builds the anomalies query string and unwraps the list", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ anomalies: [{ name: "x" }] }));
    const out = await new HttpClient(BASE).getAnomalies("s1", { severity: "critical", entity: "ORDERS" });
    expect(out).toHaveLength(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(`${BASE}/api/sessions/s1/anomalies?severity=critical&entity=ORDERS`);
  });

  it("builds the preset image URL", () => {
    expect(new HttpClient(`${BASE}/`).presetImageUrl("dotmatrix_manifest")).toBe(
      `${BASE}/api/presets/dotmatrix_manifest/image`,
    );
  });
});

describe("createClient", () => {
  it("returns the mock client only when NEXT_PUBLIC_USE_MOCK is true", () => {
    vi.stubEnv("NEXT_PUBLIC_USE_MOCK", "true");
    expect(createClient()).toBeInstanceOf(MockClient);
    vi.stubEnv("NEXT_PUBLIC_USE_MOCK", "false");
    expect(createClient()).toBeInstanceOf(HttpClient);
  });
});

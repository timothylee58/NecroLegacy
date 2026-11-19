import { mkdtemp, writeFile, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_IMAGE_BYTES, MAX_TEXT_BYTES } from "../src/file-checks.js";
import { TOOL_DEFINITIONS } from "../src/schemas.js";
import { callTool, inspectLegacySchema, queryRotAnomalies } from "../src/tools.js";
import { SESSION_ID, jsonResponse, parse, setEnv, stubFetch } from "./helpers.js";

let dir: string;
beforeEach(async () => {
  setEnv();
  dir = await mkdtemp(join(tmpdir(), "necro-mcp-"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.MCP_ANALYSIS_TIMEOUT_MS;
});

const anomaly = (severity: string, entity: string) => ({ id: `${entity}-${severity}`, severity, entity });
const completed = {
  session_id: SESSION_ID,
  status: "completed",
  node_status: {},
  schema: { entities: [{ name: "ORDERS", fields: [{ name: "id", type_confidence: 0.9 }] }] },
  rot: { anomalies: [anomaly("critical", "ORDERS"), anomaly("low", "ORDERS"), anomaly("critical", "ITEMS")] },
};

describe("missing environment", () => {
  it.each(["NECRO_API_URL", "NECRO_API_TOKEN"])("names %s and sends no request", async (name) => {
    const fetchMock = stubFetch(() => new Response("{}"));
    process.env[name] = "";
    for (const result of [
      await inspectLegacySchema({ preset: "Faded Dot-Matrix Manifest" }),
      await queryRotAnomalies({ session_id: SESSION_ID }),
    ]) {
      expect(result.isError).toBe(true);
      expect(parse(result).error.message).toContain(name);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("file checks before upload", () => {
  it("rejects bad extension, missing file, directory and signature mismatch", async () => {
    const fetchMock = stubFetch(() => new Response("{}"));
    const exe = join(dir, "a.exe");
    await writeFile(exe, "x");
    const fakePng = join(dir, "fake.png");
    await writeFile(fakePng, "not a png");
    const textAsPng = join(dir, "t.txt");
    await writeFile(textAsPng, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const codes = [];
    for (const file_path of [exe, fakePng, textAsPng, dir, join(dir, "missing.dat")]) {
      codes.push(parse(await inspectLegacySchema({ file_path })).error.code);
    }
    expect(codes).toEqual(["unsupported_extension", "signature_mismatch", "signature_mismatch", "not_a_regular_file", "file_not_found"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses a strict > size comparison for text and images", async () => {
    const fetchMock = stubFetch((url) =>
      url.endsWith("/api/sessions") ? jsonResponse({ session_id: SESSION_ID }, 201) : jsonResponse(completed),
    );
    const bigText = join(dir, "big.dat");
    await writeFile(bigText, ""); await truncate(bigText, MAX_TEXT_BYTES + 1);
    expect(parse(await inspectLegacySchema({ file_path: bigText })).error.code).toBe("file_too_large");
    const bigImage = join(dir, "big.png");
    await writeFile(bigImage, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    await truncate(bigImage, MAX_IMAGE_BYTES + 1);
    expect(parse(await inspectLegacySchema({ file_path: bigImage })).error.code).toBe("file_too_large");
    expect(fetchMock).not.toHaveBeenCalled();

    await truncate(bigText, MAX_TEXT_BYTES);
    expect((await inspectLegacySchema({ file_path: bigText })).isError).toBeUndefined();
  });

  it("requires a .cpy copybook", async () => {
    const data = join(dir, "d.dat");
    const book = join(dir, "b.txt");
    await writeFile(data, "x");
    await writeFile(book, "x");
    const fetchMock = stubFetch(() => new Response("{}"));
    const result = await inspectLegacySchema({ file_path: data, copybook_path: book });
    expect(parse(result).error.parameters).toEqual(["copybook_path"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("inspect_legacy_schema", () => {
  it("uploads a file with bearer auth and returns schema and anomaly counts", async () => {
    const file = join(dir, "ledger.dat");
    await writeFile(file, "AB001");
    const fetchMock = stubFetch((url) =>
      url.endsWith("/api/sessions") ? jsonResponse({ session_id: SESSION_ID }, 201) : jsonResponse(completed),
    );
    const result = await inspectLegacySchema({ file_path: file });
    const body = parse(result);
    expect(body.anomaly_counts).toEqual({ low: 1, medium: 0, critical: 2 });
    expect(body.schema.entities[0].name).toBe("ORDERS");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://api.test/api/sessions");
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
    expect(init!.body).toBeInstanceOf(FormData);
  });

  it("maps a preset name to its id", async () => {
    const fetchMock = stubFetch((url) =>
      url.endsWith("/preset") ? jsonResponse({ session_id: SESSION_ID }, 201) : jsonResponse(completed),
    );
    await inspectLegacySchema({ preset: "1994 Mainframe Ledger Dump" });
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({ preset_id: "ledger_1994" });
  });

  it("reports the failing node", async () => {
    stubFetch((url) =>
      url.endsWith("/preset")
        ? jsonResponse({ session_id: SESSION_ID }, 201)
        : jsonResponse({ session_id: SESSION_ID, status: "failed", node_status: { rot_detector: "failed" } }),
    );
    const result = await inspectLegacySchema({ preset: "1994 Mainframe Ledger Dump" });
    expect(result.isError).toBe(true);
    expect(parse(result).error).toMatchObject({ code: "pipeline_failed", parameters: ["rot_detector"] });
  });

  it("holds the event stream open until the terminal event, then reads the result once", async () => {
    const sse = "id: 1\nevent: node\ndata: {}\n\n: keepalive\n\nid: 9\nevent: terminal\ndata: {}\n\n";
    const fetchMock = stubFetch((url) => {
      if (url.endsWith("/preset")) return jsonResponse({ session_id: SESSION_ID }, 201);
      if (url.endsWith("/events")) return new Response(sse, { headers: { "Content-Type": "text/event-stream" } });
      return jsonResponse(completed);
    });
    const body = parse(await inspectLegacySchema({ preset: "1994 Mainframe Ledger Dump" }));
    expect(body.status).toBe("completed");
    const urls = fetchMock.mock.calls.map((c) => c[0]);
    expect(urls).toEqual([
      "http://api.test/api/sessions/preset",
      `http://api.test/api/sessions/${SESSION_ID}/events`,
      `http://api.test/api/sessions/${SESSION_ID}`,
    ]);
    expect((fetchMock.mock.calls[1]![1]!.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
  });

  it("falls back to polling when the event stream is unavailable", async () => {
    stubFetch((url) => {
      if (url.endsWith("/preset")) return jsonResponse({ session_id: SESSION_ID }, 201);
      if (url.endsWith("/events")) throw new TypeError("fetch failed");
      return jsonResponse(completed);
    });
    expect(parse(await inspectLegacySchema({ preset: "1994 Mainframe Ledger Dump" })).status).toBe("completed");
  });

  it("polls every second and returns analysis_incomplete with the session id at the timeout", async () => {
    vi.useFakeTimers();
    process.env.MCP_ANALYSIS_TIMEOUT_MS = "3500";
    const fetchMock = stubFetch((url) =>
      url.endsWith("/preset")
        ? jsonResponse({ session_id: SESSION_ID }, 201)
        : jsonResponse({ session_id: SESSION_ID, status: "running", node_status: {} }),
    );
    const pending = inspectLegacySchema({ preset: "1994 Mainframe Ledger Dump" });
    await vi.advanceTimersByTimeAsync(5000);
    const body = parse(await pending);
    expect(body.error.code).toBe("analysis_incomplete");
    expect(body.session_id).toBe(SESSION_ID);
    // create, the event stream (which ends at once here), then one poll per second.
    expect(fetchMock.mock.calls[1]![0]).toBe(`http://api.test/api/sessions/${SESSION_ID}/events`);
    expect(fetchMock.mock.calls.length).toBe(1 + 1 + 5);
  });
});

describe("api errors", () => {
  it("maps network failure to api_unavailable", async () => {
    stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    const result = await queryRotAnomalies({ session_id: SESSION_ID });
    expect(parse(result).error.code).toBe("api_unavailable");
  });

  it("aborts after 30 seconds and maps to api_unavailable", async () => {
    vi.useFakeTimers();
    const mock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    vi.stubGlobal("fetch", mock);
    const pending = queryRotAnomalies({ session_id: SESSION_ID });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(mock.mock.calls[0]![1]!.signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    const result = await pending;
    expect(parse(result).error.code).toBe("api_unavailable");
  });

  it("maps 404 to session not found", async () => {
    stubFetch(() => jsonResponse({ error: { code: "session_not_found" } }, 404));
    const result = await queryRotAnomalies({ session_id: SESSION_ID });
    expect(result.isError).toBe(true);
    expect(parse(result).error.message).toBe("session not found");
  });
});

describe("query_rot_anomalies", () => {
  it("passes both filters to the API", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ anomalies: [] }));
    await queryRotAnomalies({ session_id: SESSION_ID, severity: "critical", entity: "ORDERS" });
    expect(fetchMock.mock.calls[0]![0]).toBe(
      `http://api.test/api/sessions/${SESSION_ID}/anomalies?severity=critical&entity=ORDERS`,
    );
  });

  it("omits the query string without filters and returns the API body", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ anomalies: [anomaly("low", "X")] }));
    const result = await queryRotAnomalies({ session_id: SESSION_ID });
    expect(fetchMock.mock.calls[0]![0]).toBe(`http://api.test/api/sessions/${SESSION_ID}/anomalies`);
    expect(parse(result).anomalies).toHaveLength(1);
  });
});

describe("tool registry", () => {
  it("publishes both tools and rejects unknown names", async () => {
    expect(TOOL_DEFINITIONS.map((t) => t.name)).toEqual(["inspect_legacy_schema", "query_rot_anomalies"]);
    expect((await callTool("nope", {})).isError).toBe(true);
  });
});

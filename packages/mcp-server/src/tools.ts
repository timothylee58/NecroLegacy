import { readFile } from "node:fs/promises";
import { apiRequest, followEvents, readEnv } from "./api.js";
import { checkFile } from "./file-checks.js";
import { PRESET_IDS, invalidParameters } from "./schemas.js";
import {
  ToolError,
  type InspectInput,
  type QueryInput,
  type Severity,
  type Snapshot,
  type ToolResult,
} from "./types.js";

const POLL_INTERVAL_MS = 1_000;
const DEFAULT_ANALYSIS_TIMEOUT_MS = 300_000;

const ok = (body: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(body) }] });
const fail = (error: ToolError): ToolResult => ({
  isError: true,
  content: [{ type: "text", text: JSON.stringify(error.toBody()) }],
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function analysisTimeout(): number {
  const value = Number(process.env.MCP_ANALYSIS_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_ANALYSIS_TIMEOUT_MS;
}

function countBySeverity(snapshot: Snapshot): Record<Severity, number> {
  const counts: Record<Severity, number> = { low: 0, medium: 0, critical: 0 };
  for (const anomaly of snapshot.rot?.anomalies ?? []) counts[anomaly.severity] += 1;
  return counts;
}

async function createSession(input: InspectInput): Promise<string> {
  let created: { session_id: string };
  if (input.preset) {
    created = (await apiRequest("/api/sessions/preset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preset_id: PRESET_IDS[input.preset as keyof typeof PRESET_IDS] }),
    })) as { session_id: string };
  } else {
    const form = new FormData();
    const data = await checkFile(input.file_path as string, "file_path");
    const book = input.copybook_path ? await checkFile(input.copybook_path, "copybook_path") : null;
    if (book && (data.kind !== "text" || book.extension !== ".cpy")) {
      throw new ToolError("invalid_input", "copybook_path must be a .cpy file paired with a text data file.", ["copybook_path"]);
    }
    form.append("file", new Blob([new Uint8Array(await readFile(data.path))]), data.name);
    if (book) form.append("copybook", new Blob([new Uint8Array(await readFile(book.path))]), book.name);
    created = (await apiRequest("/api/sessions", { method: "POST", body: form })) as { session_id: string };
  }
  return created.session_id;
}

export async function inspectLegacySchema(args: unknown): Promise<ToolResult> {
  try {
    const invalid = invalidParameters("inspect_legacy_schema", args);
    if (invalid.length > 0) {
      throw new ToolError("invalid_input", `Invalid parameters: ${invalid.join(", ")}.`, invalid);
    }
    const input = args as InspectInput;
    if (input.copybook_path && !input.file_path) {
      throw new ToolError("invalid_input", "Invalid parameters: copybook_path requires file_path.", ["copybook_path"]);
    }
    readEnv();
    const sessionId = await createSession(input);
    const deadline = Date.now() + analysisTimeout();
    await followEvents(sessionId, deadline);
    for (;;) {
      const snapshot = (await apiRequest(`/api/sessions/${sessionId}`)) as Snapshot;
      if (snapshot.status === "completed") {
        return ok({
          session_id: sessionId,
          status: "completed",
          schema: { entities: snapshot.schema?.entities ?? [] },
          anomaly_counts: countBySeverity(snapshot),
        });
      }
      if (snapshot.status === "failed") {
        const failedNode = Object.entries(snapshot.node_status).find(([, state]) => state === "failed")?.[0];
        return fail(
          new ToolError("pipeline_failed", `The analysis failed${failedNode ? ` at node ${failedNode}` : ""}.`, failedNode ? [failedNode] : undefined),
        );
      }
      if (Date.now() >= deadline) {
        return ok({ error: { code: "analysis_incomplete", message: "The analysis did not finish in time." }, session_id: sessionId });
      }
      await sleep(POLL_INTERVAL_MS);
    }
  } catch (error) {
    if (error instanceof ToolError) return fail(error);
    throw error;
  }
}

export async function queryRotAnomalies(args: unknown): Promise<ToolResult> {
  try {
    const invalid = invalidParameters("query_rot_anomalies", args);
    if (invalid.length > 0) {
      throw new ToolError("invalid_input", `Invalid parameters: ${invalid.join(", ")}.`, invalid);
    }
    const input = args as QueryInput;
    readEnv();
    const query = new URLSearchParams();
    if (input.severity) query.set("severity", input.severity);
    if (input.entity) query.set("entity", input.entity);
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    const body = await apiRequest(`/api/sessions/${input.session_id}/anomalies${suffix}`);
    return ok(body);
  } catch (error) {
    if (error instanceof ToolError) return fail(error);
    throw error;
  }
}

export async function callTool(name: string, args: unknown): Promise<ToolResult> {
  if (name === "inspect_legacy_schema") return inspectLegacySchema(args);
  if (name === "query_rot_anomalies") return queryRotAnomalies(args);
  return fail(new ToolError("unknown_tool", `Unknown tool: ${name}.`, ["name"]));
}

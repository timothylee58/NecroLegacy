#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { missingEnv } from "./api.js";
import { TOOL_DEFINITIONS } from "./schemas.js";
import { callTool } from "./tools.js";

export function createServer(): Server {
  const server = new Server({ name: "necrolegacy", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...TOOL_DEFINITIONS] }));
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    callTool(request.params.name, request.params.arguments ?? {}),
  );
  return server;
}

async function main(): Promise<void> {
  // Start even when misconfigured so Kiro can list the tools; each call reports the gap.
  for (const name of missingEnv()) process.stderr.write(`necrolegacy-mcp: ${name} is not set\n`);
  await createServer().connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  process.stderr.write(`necrolegacy-mcp: fatal ${error instanceof Error ? error.message : "error"}\n`);
  process.exit(1);
});

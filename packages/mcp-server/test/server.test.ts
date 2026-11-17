import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, it } from "vitest";
import { createServer } from "../src/index.js";

afterEach(() => {
  process.env.NECRO_API_URL = "";
  process.env.NECRO_API_TOKEN = "";
});

it("lists tools and answers calls with the missing-variable error when unconfigured", async () => {
  process.env.NECRO_API_URL = "";
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverSide);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name)).toEqual(["inspect_legacy_schema", "query_rot_anomalies"]);
  const result = await client.callTool({ name: "inspect_legacy_schema", arguments: { preset: "Faded Dot-Matrix Manifest" } });
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toContain("NECRO_API_URL");
});

import { compile } from "json-schema-to-typescript";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const doc = JSON.parse(await readFile(new URL("./generated/openapi.json", import.meta.url), "utf8"));
const definitions = doc.components.schemas;
// Pydantic titles every property; dropping them keeps inline types instead of one alias per field.
const dropTitles = (node) => {
  if (Array.isArray(node)) return node.map(dropTitles);
  if (node && typeof node === "object") {
    return Object.fromEntries(
      Object.entries(node)
        .filter(([key, value]) => !(key === "title" && typeof value === "string"))
        .map(([key, value]) => [key, dropTitles(value)]),
    );
  }
  return node;
};
// The API always serializes every field (defaults included), so on the wire each property is present.
const requireAll = (node) => {
  if (Array.isArray(node)) return node.map(requireAll);
  if (node && typeof node === "object") {
    const out = Object.fromEntries(Object.entries(node).map(([key, value]) => [key, requireAll(value)]));
    if (out.properties && typeof out.properties === "object") out.required = Object.keys(out.properties);
    return out;
  }
  return node;
};
const rewrite = (node) =>
  requireAll(dropTitles(JSON.parse(JSON.stringify(node).replaceAll("#/components/schemas/", "#/definitions/"))));

const schema = {
  title: "ApiContract",
  type: "object",
  additionalProperties: false,
  properties: Object.fromEntries(Object.keys(definitions).map((name) => [name, { $ref: `#/definitions/${name}` }])),
  definitions: rewrite(definitions),
};
const source = await compile(schema, "ApiContract", {
  additionalProperties: false,
  bannerComment: "/* Generated from the FastAPI OpenAPI document by contract/generate.mjs. Do not edit. */",
  unreachableDefinitions: true,
});
await mkdir(new URL("./generated/", import.meta.url), { recursive: true });
await writeFile(new URL("./generated/api.ts", import.meta.url), source);

import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";

export const PRESET_NAMES = [
  "1994 Mainframe Ledger Dump",
  "Corrupted F&B Warehouse POS Batch",
  "Faded Dot-Matrix Manifest",
] as const;

export const PRESET_IDS: Record<(typeof PRESET_NAMES)[number], string> = {
  "1994 Mainframe Ledger Dump": "ledger_1994",
  "Corrupted F&B Warehouse POS Batch": "fnb_pos_corrupted",
  "Faded Dot-Matrix Manifest": "dotmatrix_manifest",
};

export const inspectLegacySchemaTool = {
  name: "inspect_legacy_schema",
  description: "Run a forensic analysis on a legacy file or a built-in preset and return the inferred schema.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      file_path: { type: "string", minLength: 1, description: ".dat, .txt, .csv, .cpy, .png, .jpg or .jpeg" },
      copybook_path: { type: "string", minLength: 1, description: "Optional .cpy file to pair with file_path" },
      preset: { type: "string", enum: [...PRESET_NAMES] },
    },
    oneOf: [{ required: ["file_path"] }, { required: ["preset"] }],
  },
} as const;

export const queryRotAnomaliesTool = {
  name: "query_rot_anomalies",
  description: "List anomalies of an existing analysis session, optionally filtered.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["session_id"],
    properties: {
      session_id: { type: "string", format: "uuid" },
      severity: { type: "string", enum: ["low", "medium", "critical"] },
      entity: { type: "string", minLength: 1, maxLength: 128 },
    },
  },
} as const;

export const TOOL_DEFINITIONS = [inspectLegacySchemaTool, queryRotAnomaliesTool];

const ajv = new Ajv({ allErrors: true, strict: false });
// ajv-formats ships CommonJS; under NodeNext the callable sits on `default`.
const addFormats = (addFormatsModule as unknown as { default: (a: Ajv) => void }).default ?? addFormatsModule;
(addFormats as unknown as (a: Ajv) => void)(ajv);

const validators: Record<string, ValidateFunction> = {
  inspect_legacy_schema: ajv.compile(inspectLegacySchemaTool.inputSchema),
  query_rot_anomalies: ajv.compile(queryRotAnomaliesTool.inputSchema),
};

function parameterOf(error: ErrorObject): string[] {
  const params = error.params as Record<string, unknown>;
  if (error.keyword === "required") return [String(params.missingProperty)];
  if (error.keyword === "additionalProperties") return [String(params.additionalProperty)];
  if (error.keyword === "oneOf") return ["file_path", "preset"];
  const path = error.instancePath.replace(/^\//, "");
  return path ? [path] : ["arguments"];
}

/** Returns every invalid parameter name, or an empty list when the input is valid. */
export function invalidParameters(tool: string, input: unknown): string[] {
  const validate = validators[tool];
  if (!validate) return ["tool"];
  if (typeof input !== "object" || input === null || Array.isArray(input)) return ["arguments"];
  if (validate(input)) return [];
  const names = new Set<string>();
  for (const error of validate.errors ?? []) {
    // A oneOf failure with both keys present is reported as a conflict on both.
    for (const name of parameterOf(error)) names.add(name);
  }
  return [...names];
}

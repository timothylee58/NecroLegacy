export type Severity = "low" | "medium" | "critical";

export interface ErrorBody {
  code: string;
  message: string;
  parameters?: string[];
}

export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly parameters?: string[],
  ) {
    super(message);
    this.name = "ToolError";
  }

  toBody(): { error: ErrorBody } {
    const error: ErrorBody = { code: this.code, message: this.message };
    if (this.parameters && this.parameters.length > 0) error.parameters = this.parameters;
    return { error };
  }
}

export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export interface InspectInput {
  file_path?: string;
  copybook_path?: string;
  preset?: string;
}

export interface QueryInput {
  session_id: string;
  severity?: Severity;
  entity?: string;
}

export interface SnapshotAnomaly {
  severity: Severity;
  [key: string]: unknown;
}

export interface Snapshot {
  session_id: string;
  status: "queued" | "running" | "completed" | "failed";
  node_status: Record<string, string>;
  schema?: { entities: unknown[] } | null;
  rot?: { anomalies: SnapshotAnomaly[] } | null;
}

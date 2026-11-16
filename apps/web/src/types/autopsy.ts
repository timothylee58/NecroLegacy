// Wire types: snake_case, structurally identical to apps/api/app/schemas/autopsy.py.

export type NodeName =
  | "vision_extractor"
  | "schema_archaeologist"
  | "ml_rot_scorer"
  | "rot_detector"
  | "api_resurrector";
export type NodeState = "started" | "completed" | "failed" | "skipped";
export type Severity = "low" | "medium" | "critical";
export type FieldType = "string" | "integer" | "decimal" | "date";
export type FieldRole =
  | "quantity_stock"
  | "balance"
  | "amount"
  | "identifier"
  | "branch_code"
  | "other";
export type DefectType = "smudged_digit" | "torn_total" | "misaligned_column";
export type PresetId = "ledger_1994" | "fnb_pos_corrupted" | "dotmatrix_manifest";
export type AnomalyName =
  | "orphan_foreign_key"
  | "negative_stock"
  | "negative_ledger_balance"
  | "truncated_field"
  | "byte_offset_overflow"
  | "duplicate_ledger_entry"
  | "statistical_outlier"
  | "semantic_corruption";

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VisionCell {
  row: number;
  col: number;
  text: string;
  bbox: BoundingBox;
  confidence: number;
  smudged: boolean;
}

export interface VisionDefect {
  type: DefectType;
  row: number;
  col: number;
  bbox: BoundingBox;
  confidence: number;
}

export interface VisionResult {
  image_width: number;
  image_height: number;
  skew_angle_degrees: number;
  engine: "paddleocr" | "tesseract" | "ilmu" | "claude";
  cells: VisionCell[];
  defects: VisionDefect[];
}

export interface SchemaField {
  name: string;
  type: FieldType;
  type_confidence: number;
  start: number;
  end: number;
  length: number;
  role: FieldRole;
}

export interface PrimaryKey {
  field: string | null;
  confidence: number;
}

export interface ForeignKey {
  source_field: string;
  target_entity: string;
  target_field: string;
  confidence: number;
}

export interface Entity {
  name: string;
  position_unit: "byte" | "column";
  fields: SchemaField[];
  primary_key: PrimaryKey;
  foreign_keys: ForeignKey[];
  row_count: number;
  record_length: number | null;
}

export interface SchemaResult {
  entities: Entity[];
  copybook_used: boolean;
  llm_provider?: "ilmu" | "claude" | null;
}

export interface ParseError {
  line: number;
  reason: string;
}

export interface RawPreview {
  records: string[][];
  line_delimiter: "LF" | "CRLF" | "CR" | "FIXED";
  encoding: "ascii" | "utf-8" | "ebcdic";
  encoding_confidence: number;
  encoding_uncertain: boolean;
  field_delimiter: "," | ";" | "\t" | "|" | null;
  has_header: boolean | null;
  column_boundaries: number[];
  errors: ParseError[];
}

export interface SchemaPayload extends SchemaResult {
  raw_preview?: RawPreview | null;
}

export interface SampleRow {
  row_number: number;
  values: Record<string, string>;
}

export interface Anomaly {
  id: string;
  name: AnomalyName;
  entity: string;
  field: string | null;
  affected_rows: number[];
  affected_row_count: number;
  sample_rows: SampleRow[];
  severity: Severity;
  confidence: number;
  root_cause: string;
  source: "deterministic" | "ml" | "llm";
  outlier_scores?: Record<number, number> | null;
  llm_provider?: "ilmu" | "claude" | null;
}

export interface SpatialPoint {
  entity: string;
  row_number: number;
  x: number;
  y: number;
  z: number;
  flagged: boolean;
  outlier_score: number;
}

export interface SkippedEntity {
  entity: string;
  reason: "insufficient_rows" | "no_numeric_columns" | "constant_features";
}

export interface MlResult {
  anomalies: Anomaly[];
  skipped_entities: SkippedEntity[];
  points: SpatialPoint[];
}

export interface RotResult {
  anomalies: Anomaly[];
  semantic_checks: "completed" | "skipped";
  semantic_skip_reason?: string | null;
  error?: string | null;
}

export interface IndexingStatus {
  status: "indexed" | "failed";
  record_count: number;
  reason?: string | null;
}

export interface SyntaxErrorInfo {
  line: number;
  offset: number | null;
  message: string;
}

export interface ResurrectionResult {
  source: string | null;
  syntax_ok: boolean;
  syntax_error: SyntaxErrorInfo | null;
  indexing: IndexingStatus;
  models: string[];
}

export type SessionEvent =
  | { id: number; type: "node"; node: "vision_extractor"; state: "completed"; payload: VisionResult }
  | { id: number; type: "node"; node: "schema_archaeologist"; state: "completed"; payload: SchemaPayload }
  | { id: number; type: "node"; node: "ml_rot_scorer"; state: "completed"; payload: MlResult }
  | { id: number; type: "node"; node: "rot_detector"; state: "completed"; payload: RotResult }
  | { id: number; type: "node"; node: "api_resurrector"; state: "completed"; payload: ResurrectionResult }
  | { id: number; type: "node"; node: NodeName; state: "started"; payload: Record<string, never> }
  | { id: number; type: "node"; node: NodeName; state: "skipped"; payload: { reason: string } }
  | { id: number; type: "node"; node: NodeName; state: "failed"; payload: { code: string; message: string } }
  | { id: number; type: "fallback"; payload: { failed_provider: "ilmu"; reason: "error" | "timeout" | "validation" } }
  | { id: number; type: "error"; payload: { node: NodeName; code: string; message: string } }
  | { id: number; type: "terminal"; payload: { status: "completed" | "failed"; failed_node?: NodeName } };

export interface CreateSessionResponse {
  session_id: string;
  input_kind: "text" | "image";
  cached: boolean;
}

export interface SearchHit {
  entity: string;
  row_number: number;
  similarity: number;
  anomaly_flags: AnomalyName[];
  preview: string;
}

export interface SearchResponse {
  hits: SearchHit[];
}

// The design leaves FieldError undefined; shape is a field path plus message.
export interface FieldError {
  field: string;
  message: string;
}

export interface ErrorBody {
  code: string;
  message: string;
  fields?: FieldError[] | null;
}

export interface ErrorResponse {
  error: ErrorBody;
}

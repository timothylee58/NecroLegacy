import type {
  Anomaly,
  BoundingBox,
  DefectType,
  Entity,
  MlResult,
  NodeName,
  ResurrectionResult,
  RotResult,
  SchemaPayload,
  SessionEvent,
  SpatialPoint,
  VisionCell,
  VisionDefect,
  VisionResult,
} from "@/types/autopsy";
import { FNB_ML, FNB_RESURRECTION, FNB_ROT, FNB_SCHEMA } from "./mock-fnb";

export const NODE_ORDER: readonly NodeName[] = [
  "vision_extractor",
  "schema_archaeologist",
  "ml_rot_scorer",
  "rot_detector",
  "api_resurrector",
];

export const POINTS_PER_ENTITY = 600;
const COORD_RANGE = 3.4;
const FLAGGED_PER_ENTITY = 36;

// Deterministic so fixtures are stable across renders and test runs.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function round(n: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

// ---------------------------------------------------------------- ledger preset

export const LEDGER_ENTITIES: Entity[] = [
  {
    name: "LEDGER_ENTRY",
    position_unit: "byte",
    fields: [
      { name: "ENTRY_ID", type: "integer", type_confidence: 0.98, start: 0, end: 8, length: 8, role: "identifier" },
      { name: "ACCOUNT_ID", type: "integer", type_confidence: 0.96, start: 8, end: 16, length: 8, role: "identifier" },
      { name: "POST_DATE", type: "date", type_confidence: 0.93, start: 16, end: 24, length: 8, role: "other" },
      { name: "AMOUNT", type: "decimal", type_confidence: 0.95, start: 24, end: 36, length: 12, role: "amount" },
    ],
    primary_key: { field: "ENTRY_ID", confidence: 0.97 },
    foreign_keys: [
      { source_field: "ACCOUNT_ID", target_entity: "ACCOUNT", target_field: "ACCOUNT_ID", confidence: 0.91 },
    ],
    row_count: POINTS_PER_ENTITY,
    record_length: 36,
  },
  {
    name: "ACCOUNT",
    position_unit: "byte",
    fields: [
      { name: "ACCOUNT_ID", type: "integer", type_confidence: 0.99, start: 0, end: 8, length: 8, role: "identifier" },
      { name: "BRANCH_CODE", type: "string", type_confidence: 0.9, start: 8, end: 12, length: 4, role: "branch_code" },
      { name: "BALANCE", type: "decimal", type_confidence: 0.94, start: 12, end: 24, length: 12, role: "balance" },
    ],
    primary_key: { field: "ACCOUNT_ID", confidence: 0.99 },
    foreign_keys: [
      { source_field: "BRANCH_CODE", target_entity: "BRANCH", target_field: "BRANCH_CODE", confidence: 0.88 },
    ],
    row_count: POINTS_PER_ENTITY,
    record_length: 24,
  },
  {
    name: "BRANCH",
    position_unit: "byte",
    fields: [
      { name: "BRANCH_CODE", type: "string", type_confidence: 0.97, start: 0, end: 4, length: 4, role: "branch_code" },
      { name: "BRANCH_NAME", type: "string", type_confidence: 0.92, start: 4, end: 24, length: 20, role: "other" },
      { name: "HEADCOUNT", type: "integer", type_confidence: 0.9, start: 24, end: 28, length: 4, role: "other" },
    ],
    primary_key: { field: "BRANCH_CODE", confidence: 0.98 },
    foreign_keys: [],
    row_count: POINTS_PER_ENTITY,
    record_length: 28,
  },
];

function buildPoints(entity: string, seed: number, flaggedCount: number): SpatialPoint[] {
  const rand = mulberry32(seed);
  const jitter = (spread: number) => (rand() - 0.5) * spread;
  const points: SpatialPoint[] = [];
  // The API normalizes PCA coordinates into [-1, 1]; the scene scales them back up.
  const unit = (v: number) => round(Math.max(-1, Math.min(1, v / COORD_RANGE)));
  for (let i = 0; i < POINTS_PER_ENTITY; i++) {
    const flagged = i < flaggedCount;
    const cx = flagged ? 3.2 : 0;
    const cy = flagged ? 2.6 : 0;
    const cz = flagged ? -2.8 : 0;
    const spread = flagged ? 0.6 : 1.4;
    points.push({
      entity,
      row_number: i + 1,
      x: unit(cx + jitter(spread)),
      y: unit(cy + jitter(spread)),
      z: unit(cz + jitter(spread)),
      flagged,
      outlier_score: round(flagged ? 0.72 + rand() * 0.27 : rand() * 0.45),
    });
  }
  return points;
}

// Clean entity still carries an unflagged cluster plus a small flagged tail so
// the scene shows both states; its anomalies list stays empty.
export const LEDGER_POINTS: SpatialPoint[] = [
  ...buildPoints("LEDGER_ENTRY", 1994, FLAGGED_PER_ENTITY),
  ...buildPoints("ACCOUNT", 1995, FLAGGED_PER_ENTITY),
  ...buildPoints("BRANCH", 1996, 6),
];

const orphanRows = [17, 88, 203, 349];
const outlierRows = LEDGER_POINTS.filter((p) => p.entity === "ACCOUNT" && p.flagged).map((p) => p.row_number);

export const LEDGER_ANOMALIES = {
  deterministic: [
    {
      id: "an-orphan-fk-1",
      name: "orphan_foreign_key",
      entity: "LEDGER_ENTRY",
      field: "ACCOUNT_ID",
      affected_rows: orphanRows,
      affected_row_count: orphanRows.length,
      sample_rows: orphanRows.map((r) => ({
        row_number: r,
        values: { ENTRY_ID: String(10000 + r), ACCOUNT_ID: String(9000000 + r), AMOUNT: "1250.00" },
      })),
      severity: "critical",
      confidence: 0.97,
      root_cause: "ACCOUNT_ID values have no matching row in ACCOUNT.",
      source: "deterministic",
    },
  ] satisfies Anomaly[],
  ml: [
    {
      id: "an-outlier-1",
      name: "statistical_outlier",
      entity: "ACCOUNT",
      field: "BALANCE",
      affected_rows: outlierRows,
      affected_row_count: outlierRows.length,
      sample_rows: outlierRows.slice(0, 3).map((r) => ({
        row_number: r,
        values: { ACCOUNT_ID: String(500000 + r), BALANCE: "98234871.55" },
      })),
      severity: "medium",
      confidence: 0.82,
      root_cause: "Balances sit far outside the isolation forest's normal range.",
      source: "ml",
      outlier_scores: Object.fromEntries(
        LEDGER_POINTS.filter((p) => p.entity === "ACCOUNT" && p.flagged).map((p) => [p.row_number, p.outlier_score]),
      ),
    },
  ] satisfies Anomaly[],
};

export const LEDGER_SCHEMA: SchemaPayload = {
  entities: LEDGER_ENTITIES,
  copybook_used: false,
  llm_provider: "primary",
  // First 20 records of the real API's preview for the 1994 ledger preset.
  raw_preview: {
    records: [
      ["AC", "acct", "name                 brn  balance"],
      ["AC", "A01000", "Cash On Hand         N001 43507.26"],
      ["AC", "A01010", "Trade Debtors        N002 58028.10"],
      ["AC", "A01020", "Inventory Control    S001 63703.78"],
      ["AC", "A01030", "Prepaid Rent         N001 33892.98"],
      ["AC", "A01040", "Office Equipment     N002 14558.31"],
      ["AC", "A01050", "Trade Creditors      S001 30207.38"],
      ["AC", "A01060", "Accrued Wages        N001 23333.85"],
      ["AC", "A01070", "Sales Revenue        N002 79561.55"],
      ["AC", "A01080", "Cost Of Goods        S001 84172.22"],
      ["AC", "A01090", "Freight Expense      N001 69068.71"],
      ["AC", "A01100", "Utilities Expense    N002 3985.37"],
      ["AC", "A01110", "Depreciation         S001 50943.43"],
      ["AC", "A01120", "Retained Earnings    N001 82199.39"],
      ["AC", "A01130", "Loan Payable         N002 2837.20"],
      ["AC", "A01140", "Petty Cash           S001 35377.37"],
      ["AC", "A01150", "Insurance Prepaid    N001 47582.25"],
      ["AC", "A01160", "Bank Charges         N002 87947.83"],
      ["AC", "A01170", "Returns Allowance    S001 64666.24"],
      ["AC", "A01180", "Supplies Expense     N001 15024.93"],
    ],
    line_delimiter: "LF",
    encoding: "ascii",
    encoding_confidence: 1.0,
    encoding_uncertain: false,
    field_delimiter: null,
    has_header: null,
    column_boundaries: [0, 3, 10],
    errors: [],
  },
};

export const LEDGER_ML: MlResult = {
  anomalies: LEDGER_ANOMALIES.ml,
  skipped_entities: [],
  points: LEDGER_POINTS,
};

export const LEDGER_ML_SKIPPED_ENTITIES: MlResult = {
  anomalies: [],
  skipped_entities: LEDGER_ENTITIES.map((e) => ({ entity: e.name, reason: "insufficient_rows" as const })),
  points: [],
};

export const LEDGER_ROT: RotResult = {
  anomalies: [...LEDGER_ANOMALIES.deterministic, ...LEDGER_ANOMALIES.ml],
  semantic_checks: "completed",
  semantic_skip_reason: null,
  error: null,
};

// Produced by apps/api/app/services/codegen.py from the three entities above, so the mock shows real output.
export const LEDGER_RESURRECTION: ResurrectionResult = {
  source: "from fastapi import FastAPI\nfrom decimal import Decimal\nfrom typing import Annotated\n\nfrom fastapi import APIRouter, HTTPException\nfrom pydantic import BaseModel, Field\n\n\nclass LedgerEntry(BaseModel):\n    ENTRY_ID: Annotated[int, Field(gt=-100000000, lt=100000000, json_schema_extra={\"legacy_length\": 8})]\n    # orphan_foreign_key (critical)\n    ACCOUNT_ID: Annotated[int, Field(gt=-100000000, lt=100000000, json_schema_extra={\"legacy_length\": 8})]\n    POST_DATE: Annotated[str, Field(pattern='^[0-9]{2,4}[-/.]?[0-9]{2}[-/.]?[0-9]{2,4}$', json_schema_extra={\"legacy_length\": 8})]\n    AMOUNT: Annotated[Decimal, Field(max_digits=12, json_schema_extra={\"legacy_length\": 12})]\n\n\nrouter_ledger_entry = APIRouter(prefix='/ledger-entry', tags=['/ledger-entry'])\nstore_ledger_entry: dict[int, LedgerEntry] = {}\n\n\n@router_ledger_entry.post(\"\", status_code=201)\ndef create_ledger_entry(item: LedgerEntry) -> dict[str, object]:\n    item_id = max(store_ledger_entry, default=0) + 1\n    store_ledger_entry[item_id] = item\n    return {\"id\": item_id, \"item\": item}\n\n\n@router_ledger_entry.get(\"/{item_id}\")\ndef read_ledger_entry(item_id: int) -> LedgerEntry:\n    if item_id not in store_ledger_entry:\n        raise HTTPException(status_code=404, detail=\"not found\")\n    return store_ledger_entry[item_id]\n\n\n@router_ledger_entry.get(\"\")\ndef list_ledger_entry() -> list[LedgerEntry]:\n    return list(store_ledger_entry.values())\n\n\n@router_ledger_entry.put(\"/{item_id}\")\ndef update_ledger_entry(item_id: int, item: LedgerEntry) -> LedgerEntry:\n    if item_id not in store_ledger_entry:\n        raise HTTPException(status_code=404, detail=\"not found\")\n    store_ledger_entry[item_id] = item\n    return item\n\n\n@router_ledger_entry.delete(\"/{item_id}\", status_code=204)\ndef delete_ledger_entry(item_id: int) -> None:\n    if store_ledger_entry.pop(item_id, None) is None:\n        raise HTTPException(status_code=404, detail=\"not found\")\n\n\nclass Account(BaseModel):\n    ACCOUNT_ID: Annotated[int, Field(gt=-100000000, lt=100000000, json_schema_extra={\"legacy_length\": 8})]\n    BRANCH_CODE: Annotated[str, Field(max_length=4, json_schema_extra={\"legacy_length\": 4})]\n    # statistical_outlier (medium)\n    BALANCE: Annotated[Decimal, Field(max_digits=12, json_schema_extra={\"legacy_length\": 12})]\n\n\nrouter_account = APIRouter(prefix='/account', tags=['/account'])\nstore_account: dict[int, Account] = {}\n\n\n@router_account.post(\"\", status_code=201)\ndef create_account(item: Account) -> dict[str, object]:\n    item_id = max(store_account, default=0) + 1\n    store_account[item_id] = item\n    return {\"id\": item_id, \"item\": item}\n\n\n@router_account.get(\"/{item_id}\")\ndef read_account(item_id: int) -> Account:\n    if item_id not in store_account:\n        raise HTTPException(status_code=404, detail=\"not found\")\n    return store_account[item_id]\n\n\n@router_account.get(\"\")\ndef list_account() -> list[Account]:\n    return list(store_account.values())\n\n\n@router_account.put(\"/{item_id}\")\ndef update_account(item_id: int, item: Account) -> Account:\n    if item_id not in store_account:\n        raise HTTPException(status_code=404, detail=\"not found\")\n    store_account[item_id] = item\n    return item\n\n\n@router_account.delete(\"/{item_id}\", status_code=204)\ndef delete_account(item_id: int) -> None:\n    if store_account.pop(item_id, None) is None:\n        raise HTTPException(status_code=404, detail=\"not found\")\n\n\nclass Branch(BaseModel):\n    BRANCH_CODE: Annotated[str, Field(max_length=4, json_schema_extra={\"legacy_length\": 4})]\n    BRANCH_NAME: Annotated[str, Field(max_length=20, json_schema_extra={\"legacy_length\": 20})]\n    HEADCOUNT: Annotated[int, Field(gt=-10000, lt=10000, json_schema_extra={\"legacy_length\": 4})]\n\n\nrouter_branch = APIRouter(prefix='/branch', tags=['/branch'])\nstore_branch: dict[int, Branch] = {}\n\n\n@router_branch.post(\"\", status_code=201)\ndef create_branch(item: Branch) -> dict[str, object]:\n    item_id = max(store_branch, default=0) + 1\n    store_branch[item_id] = item\n    return {\"id\": item_id, \"item\": item}\n\n\n@router_branch.get(\"/{item_id}\")\ndef read_branch(item_id: int) -> Branch:\n    if item_id not in store_branch:\n        raise HTTPException(status_code=404, detail=\"not found\")\n    return store_branch[item_id]\n\n\n@router_branch.get(\"\")\ndef list_branch() -> list[Branch]:\n    return list(store_branch.values())\n\n\n@router_branch.put(\"/{item_id}\")\ndef update_branch(item_id: int, item: Branch) -> Branch:\n    if item_id not in store_branch:\n        raise HTTPException(status_code=404, detail=\"not found\")\n    store_branch[item_id] = item\n    return item\n\n\n@router_branch.delete(\"/{item_id}\", status_code=204)\ndef delete_branch(item_id: int) -> None:\n    if store_branch.pop(item_id, None) is None:\n        raise HTTPException(status_code=404, detail=\"not found\")\n\n\napp = FastAPI()\napp.include_router(router_ledger_entry)\napp.include_router(router_account)\napp.include_router(router_branch)\n",
  syntax_ok: true,
  syntax_error: null,
  indexing: { status: "indexed", record_count: POINTS_PER_ENTITY * 3 },
  models: ["LedgerEntry", "Account", "Branch"],
};

// ---------------------------------------------------------------- image fixture

export const IMAGE_ROWS = 5;
export const IMAGE_COLS = 4;
export const IMAGE_WIDTH = 800;
export const IMAGE_HEIGHT = 500;

const CELL_W = 180;
const CELL_H = 80;
const ORIGIN_X = 40;
const ORIGIN_Y = 50;
const GAP_X = 10;
const GAP_Y = 10;

// Same synthetic F&B batch as mock-fnb.ts: the smudged sign bit on row 1 is the -420 stock delta to PJ-999.
const HEADER = ["SKU", "QTY", "DEST_HUB", "TOTAL_RM"];
const BODY: string[][] = [
  ["SKU-8821", "-420", "PJ-999", "-6090.00"],
  ["SKU-1043", "120", "KL-001", "384.00"],
  ["SKU-2210", "300", "KL-001", "960.00"],
  ["SKU-3307", "45", "SA-002", "351.00"],
];

const DEFECT_AT: Record<string, DefectType> = {
  "1,1": "smudged_digit",
  "2,3": "misaligned_column",
  "4,3": "torn_total",
};
const DEFECT_CONFIDENCE: Record<DefectType, number> = {
  smudged_digit: 0.41,
  misaligned_column: 0.52,
  torn_total: 0.33,
};

function cellBox(row: number, col: number): BoundingBox {
  const shift = DEFECT_AT[`${row},${col}`] === "misaligned_column" ? 14 : 0;
  return {
    x: ORIGIN_X + col * (CELL_W + GAP_X) + shift,
    y: ORIGIN_Y + row * (CELL_H + GAP_Y),
    width: CELL_W,
    height: CELL_H,
  };
}

function buildVision(): VisionResult {
  const cells: VisionCell[] = [];
  const defects: VisionDefect[] = [];
  for (let row = 0; row < IMAGE_ROWS; row++) {
    for (let col = 0; col < IMAGE_COLS; col++) {
      const text = (row === 0 ? HEADER[col] : BODY[row - 1]?.[col]) ?? "";
      const defect = DEFECT_AT[`${row},${col}`];
      const bbox = cellBox(row, col);
      const confidence = defect ? DEFECT_CONFIDENCE[defect] : round(0.9 + ((row * 7 + col * 3) % 9) / 100, 2);
      // Grid indices are 1-based on the wire; the loop and DEFECT_AT stay 0-based.
      cells.push({ row: row + 1, col: col + 1, text, bbox, confidence, smudged: defect === "smudged_digit" });
      if (defect) defects.push({ type: defect, row: row + 1, col: col + 1, bbox, confidence });
    }
  }
  return {
    image_width: IMAGE_WIDTH,
    image_height: IMAGE_HEIGHT,
    skew_angle_degrees: 1.8,
    engine: "tesseract",
    cells,
    defects,
  };
}

export const MOCK_VISION: VisionResult = buildVision();

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Rendered from the same boxes as MOCK_VISION so overlay rectangles line up exactly.
export function buildImageSvg(vision: VisionResult = MOCK_VISION): string {
  const defectKeys = new Set(vision.defects.map((d) => `${d.row},${d.col}`));
  const cells = vision.cells
    .map((c) => {
      const { x, y, width, height } = c.bbox;
      const stroke = defectKeys.has(`${c.row},${c.col}`) ? "#7f1d1d" : "#6b7280";
      const label = escapeXml(c.text);
      return (
        `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="#fffdf5" stroke="${stroke}" stroke-width="1"/>` +
        `<text x="${x + 12}" y="${y + height / 2 + 6}" font-family="monospace" font-size="20" fill="#1f2937">${label}</text>`
      );
    })
    .join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${vision.image_width}" height="${vision.image_height}" ` +
    `viewBox="0 0 ${vision.image_width} ${vision.image_height}">` +
    `<rect width="100%" height="100%" fill="#e7e0c9"/>${cells}</svg>`
  );
}

export function buildImageDataUri(vision: VisionResult = MOCK_VISION): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(buildImageSvg(vision))}`;
}

export const MOCK_IMAGE_DATA_URI = buildImageDataUri();

// ---------------------------------------------------------------- event scripts

export interface MockDataset {
  schema: SchemaPayload;
  ml: MlResult;
  rot: RotResult;
  resurrection: ResurrectionResult;
}

export const LEDGER_DATASET: MockDataset = {
  schema: LEDGER_SCHEMA,
  ml: LEDGER_ML,
  rot: LEDGER_ROT,
  resurrection: LEDGER_RESURRECTION,
};

export const FNB_DATASET: MockDataset = {
  schema: FNB_SCHEMA,
  ml: FNB_ML,
  rot: FNB_ROT,
  resurrection: FNB_RESURRECTION,
};

type NodePayloads = {
  vision_extractor: VisionResult;
  schema_archaeologist: SchemaPayload;
  ml_rot_scorer: MlResult;
  rot_detector: RotResult;
  api_resurrector: ResurrectionResult;
};

function completedEvent<N extends NodeName>(id: number, node: N, payload: NodePayloads[N]): SessionEvent {
  return { id, type: "node", node, state: "completed", payload } as SessionEvent;
}

export interface ScriptOptions {
  input?: "text" | "image";
  variant?: "default" | "rot_detector_failure" | "ml_skipped";
  dataset?: MockDataset;
}

export function buildEventScript({
  input = "text",
  variant = "default",
  dataset = LEDGER_DATASET,
}: ScriptOptions = {}): SessionEvent[] {
  const events: SessionEvent[] = [];
  const push = (e: (id: number) => SessionEvent) => events.push(e(events.length + 1));

  const nodePayloads: NodePayloads = {
    vision_extractor: MOCK_VISION,
    schema_archaeologist: dataset.schema,
    ml_rot_scorer: dataset.ml,
    rot_detector: dataset.rot,
    api_resurrector: dataset.resurrection,
  };

  for (const node of NODE_ORDER) {
    if (node === "vision_extractor" && input === "text") {
      push((id) => ({ id, type: "node", node, state: "skipped", payload: { reason: "text_input" } }));
      continue;
    }
    if (node === "ml_rot_scorer" && variant === "ml_skipped") {
      push((id) => ({ id, type: "node", node, state: "started", payload: {} }));
      push((id) => ({ id, type: "node", node, state: "skipped", payload: { reason: "insufficient_rows" } }));
      continue;
    }
    push((id) => ({ id, type: "node", node, state: "started", payload: {} }));
    if (node === "rot_detector" && variant === "rot_detector_failure") {
      push((id) => ({
        id,
        type: "node",
        node,
        state: "failed",
        payload: { code: "rot_detector_failed", message: "Rot detection failed unexpectedly." },
      }));
      push((id) => ({
        id,
        type: "error",
        payload: { node, code: "rot_detector_failed", message: "Rot detection failed unexpectedly." },
      }));
      push((id) => ({ id, type: "terminal", payload: { status: "failed", failed_node: node } }));
      return events;
    }
    push((id) => completedEvent(id, node, nodePayloads[node]));
  }

  push((id) => ({ id, type: "terminal", payload: { status: "completed" } }));
  return events;
}

export const TEXT_EVENT_SCRIPT: SessionEvent[] = buildEventScript({ input: "text" });
export const FNB_EVENT_SCRIPT: SessionEvent[] = buildEventScript({ input: "text", dataset: FNB_DATASET });
export const IMAGE_EVENT_SCRIPT: SessionEvent[] = buildEventScript({ input: "image", dataset: FNB_DATASET });
export const ROT_DETECTOR_FAILURE_SCRIPT: SessionEvent[] = buildEventScript({ variant: "rot_detector_failure" });
export const ML_SKIPPED_SCRIPT: SessionEvent[] = buildEventScript({ variant: "ml_skipped" });

// ---------------------------------------------------------------- timed player

export interface TimedOptions {
  intervalMs?: number;
  signal?: AbortSignal;
  /** Resume after this event id, mirroring Last-Event-ID. */
  afterId?: number;
}

function wait(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function* timedEvents(
  script: SessionEvent[],
  { intervalMs = 400, signal, afterId = 0 }: TimedOptions = {},
): AsyncGenerator<SessionEvent> {
  for (const event of script) {
    if (event.id <= afterId) continue;
    if (!(await wait(intervalMs, signal))) return;
    yield event;
  }
}

/** Callback form for client code; returns a cancel function. */
export function playEvents(
  script: SessionEvent[],
  onEvent: (event: SessionEvent) => void,
  options: Omit<TimedOptions, "signal"> = {},
): () => void {
  const controller = new AbortController();
  void (async () => {
    for await (const event of timedEvents(script, { ...options, signal: controller.signal })) {
      onEvent(event);
    }
  })();
  return () => controller.abort();
}

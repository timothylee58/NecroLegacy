import type { Anomaly, Entity, MlResult, ResurrectionResult, RotResult, SchemaPayload, SpatialPoint } from "@/types/autopsy";
import { mulberry32 } from "@/lib/scene/layout";

// Synthetic F&B warehouse batch: every SKU, hub and transaction id is invented.

const MAX_POINTS = 600;
const OUTLIER_THRESHOLD = -0.15;

function round(n: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export const FNB_ENTITIES: Entity[] = [
  {
    name: "INV_LEDGER_94",
    position_unit: "column",
    fields: [
      { name: "txn_id", type: "string", type_confidence: 0.97, start: 0, end: 1, length: 10, role: "identifier" },
      { name: "sku_code", type: "string", type_confidence: 0.95, start: 1, end: 2, length: 8, role: "identifier" },
      { name: "qty_delta", type: "integer", type_confidence: 0.93, start: 2, end: 3, length: 6, role: "quantity_stock" },
      { name: "dest_hub_id", type: "string", type_confidence: 0.9, start: 3, end: 4, length: 4, role: "branch_code" },
    ],
    primary_key: { field: "txn_id", confidence: 0.94 },
    foreign_keys: [
      { source_field: "dest_hub_id", target_entity: "MASTER_HUBS_MY", target_field: "hub_id", confidence: 0.89 },
      { source_field: "sku_code", target_entity: "POS_PRICE_TIER", target_field: "sku_code", confidence: 0.92 },
    ],
    row_count: 4820,
    record_length: null,
  },
  {
    name: "MASTER_HUBS_MY",
    position_unit: "column",
    fields: [
      { name: "hub_id", type: "string", type_confidence: 0.99, start: 0, end: 1, length: 4, role: "branch_code" },
      { name: "region", type: "string", type_confidence: 0.98, start: 1, end: 2, length: 12, role: "other" },
    ],
    primary_key: { field: "hub_id", confidence: 0.99 },
    foreign_keys: [],
    row_count: 42,
    record_length: null,
  },
  {
    name: "POS_PRICE_TIER",
    position_unit: "column",
    fields: [
      { name: "sku_code", type: "string", type_confidence: 0.96, start: 0, end: 1, length: 8, role: "identifier" },
      { name: "unit_price_myr", type: "decimal", type_confidence: 0.88, start: 1, end: 2, length: 9, role: "amount" },
    ],
    primary_key: { field: "sku_code", confidence: 0.95 },
    foreign_keys: [],
    row_count: 1190,
    record_length: null,
  },
];

const NEGATIVE_STOCK_ROWS = [1402, 1403, 1977, 2210, 2875, 3301, 3302, 4018];
const ORPHAN_HUB_ROWS = [1402, 1977, 2875, 3301, 4018, 4411];
const ZERO_PRICE_ROWS = [88, 91, 214, 377, 402, 519, 640, 702, 811, 905, 1033, 1150];

// Flagged rows sit in one tight cluster away from the healthy cloud so the
// embedding-PCA separation is visible; coordinates stay within -1..1.
function buildPoints(entity: string, rowCount: number, flaggedRows: number[], seed: number): SpatialPoint[] {
  const rand = mulberry32(seed);
  const flagged = new Set(flaggedRows);
  const unflaggedCount = Math.min(rowCount, MAX_POINTS) - flaggedRows.length;
  const stride = Math.max(1, Math.ceil((rowCount - flaggedRows.length) / Math.max(1, unflaggedCount)));
  const rows = [...flaggedRows];
  for (let r = 1; r <= rowCount && rows.length < Math.min(rowCount, MAX_POINTS); r += stride) {
    if (!flagged.has(r)) rows.push(r);
  }
  return rows.map((row_number) => {
    const isFlagged = flagged.has(row_number);
    const [cx, cy, cz, spread] = isFlagged ? [0.7, 0.6, -0.65, 0.25] : [-0.2, -0.15, 0.2, 0.9];
    const j = () => (rand() - 0.5) * spread;
    return {
      entity,
      row_number,
      x: round(cx + j()),
      y: round(cy + j()),
      z: round(cz + j()),
      flagged: isFlagged,
      outlier_score: round(isFlagged ? -0.16 - rand() * 0.15 : 0.02 + rand() * 0.2),
    };
  });
}

export const FNB_POINTS: SpatialPoint[] = [
  ...buildPoints("INV_LEDGER_94", 4820, NEGATIVE_STOCK_ROWS, 9408),
  ...buildPoints("MASTER_HUBS_MY", 42, [], 9409),
  ...buildPoints("POS_PRICE_TIER", 1190, ZERO_PRICE_ROWS, 9410),
];

function scoresFor(entity: string): Record<number, number> {
  const scores = Object.fromEntries(
    FNB_POINTS.filter((p) => p.entity === entity && p.flagged).map((p) => [p.row_number, p.outlier_score]),
  );
  // Rows called out in the fixture narrative keep their documented scores.
  if (entity === "INV_LEDGER_94") scores[1402] = -0.31;
  if (entity === "POS_PRICE_TIER") scores[88] = -0.18;
  return scores;
}

const ledgerRow = (r: number, qty: string, hub: string) => ({
  row_number: r,
  values: { txn_id: `TXN${9000 + (r % 1000)}`, sku_code: "SKU-8821", qty_delta: qty, dest_hub_id: hub },
});

export const FNB_DETERMINISTIC: Anomaly[] = [
  {
    id: "fnb-orphan-hub",
    name: "orphan_foreign_key",
    entity: "INV_LEDGER_94",
    field: "dest_hub_id",
    affected_rows: ORPHAN_HUB_ROWS,
    affected_row_count: ORPHAN_HUB_ROWS.length,
    sample_rows: ORPHAN_HUB_ROWS.slice(0, 5).map((r) => ledgerRow(r, r === 1402 ? "-00420" : "+00012", "PJ-999")),
    severity: "critical",
    confidence: 0.98,
    root_cause: "Hub PJ-999 is missing from MASTER_HUBS_MY; the Petaling Jaya sub-warehouse code was never migrated.",
    source: "deterministic",
  },
  {
    id: "fnb-negative-stock",
    name: "negative_stock",
    entity: "INV_LEDGER_94",
    field: "qty_delta",
    affected_rows: NEGATIVE_STOCK_ROWS,
    affected_row_count: 38,
    sample_rows: NEGATIVE_STOCK_ROWS.slice(0, 5).map((r) => ledgerRow(r, r === 1402 ? "-00420" : "-00036", r === 1402 ? "PJ-999" : "KL-001")),
    severity: "critical",
    confidence: 0.96,
    root_cause: "Running stock goes negative (-420 at row 1402); OCR ink bleed flipped sign bits on the scanned manifest.",
    source: "deterministic",
  },
];

export const FNB_ML_ANOMALIES: Anomaly[] = [
  {
    id: "fnb-outlier-qty",
    name: "statistical_outlier",
    entity: "INV_LEDGER_94",
    field: "qty_delta",
    affected_rows: NEGATIVE_STOCK_ROWS,
    affected_row_count: NEGATIVE_STOCK_ROWS.length,
    sample_rows: [ledgerRow(1402, "-00420", "PJ-999")],
    severity: "medium",
    confidence: 0.84,
    root_cause: `Isolation Forest scored these stock deltas below ${OUTLIER_THRESHOLD}; row 1402 scored -0.31.`,
    source: "ml",
    outlier_scores: scoresFor("INV_LEDGER_94"),
  },
  {
    id: "fnb-outlier-price",
    name: "statistical_outlier",
    entity: "POS_PRICE_TIER",
    field: "unit_price_myr",
    affected_rows: ZERO_PRICE_ROWS,
    affected_row_count: ZERO_PRICE_ROWS.length,
    sample_rows: ZERO_PRICE_ROWS.slice(0, 3).map((r) => ({
      row_number: r,
      values: { sku_code: r === 88 ? "SKU-8821" : `SKU-${4000 + r}`, unit_price_myr: "0000.00" },
    })),
    severity: "medium",
    confidence: 0.79,
    root_cause: "12 active SKUs have a 0.00 MYR unit price, consistent with fixed-width decimal truncation.",
    source: "ml",
    outlier_scores: scoresFor("POS_PRICE_TIER"),
  },
];

export const FNB_SCHEMA: SchemaPayload = {
  entities: FNB_ENTITIES,
  copybook_used: false,
  llm_provider: "primary",
  // First 20 records of the real API's preview for the F&B preset.
  raw_preview: {
    records: [
      ["BR", "branch_code", "branch_name", "zone"],
      ["BR", "N001", "Warehouse N001", "FROZEN"],
      ["BR", "N002", "Warehouse N002", "DRY"],
      ["BR", "S001", "Warehouse S001", "CHILL"],
      ["BR", "S002", "Warehouse S002", "CHILL"],
      ["BR", "E001", "Warehouse E001", "DRY"],
      ["BR", "W001", "Warehouse W001", "FROZEN"],
      ["PR", "sku_code", "product_name", "unit_price"],
      ["PR", "SKU1000", "Rice 5kg", "12.77"],
      ["PR", "SKU1001", "Cooking Oil 2L", "22.51"],
      ["PR", "SKU1002", "Sugar 1kg", "5.77"],
      ["PR", "SKU1003", "Flour 1kg", "8.76"],
      ["PR", "SKU1004", "Canned Tuna", "13.95"],
      ["PR", "SKU1005", "Instant Noodles", "11.22"],
      ["PR", "SKU1006", "Soy Sauce", "12.58"],
      ["PR", "SKU1007", "Frozen Chicken", "4.72"],
      ["PR", "SKU1008", "Frozen Prawns", "14.43"],
      ["PR", "SKU1009", "Fresh Milk 1L", "7.60"],
      ["PR", "SKU1010", "Cheddar Slice", "13.50"],
      ["PR", "SKU1011", "Butter Block", "16.23"],
    ],
    line_delimiter: "LF",
    encoding: "ascii",
    encoding_confidence: 1.0,
    encoding_uncertain: false,
    field_delimiter: "|",
    has_header: false,
    column_boundaries: [],
    errors: [],
  },
};

export const FNB_ML: MlResult = {
  anomalies: FNB_ML_ANOMALIES,
  skipped_entities: [],
  points: FNB_POINTS,
};

export const FNB_ROT: RotResult = {
  anomalies: [...FNB_DETERMINISTIC, ...FNB_ML_ANOMALIES],
  semantic_checks: "completed",
  semantic_skip_reason: null,
  error: null,
};

// Produced by apps/api/app/services/codegen.py from the entities and anomalies above.
export const FNB_RESURRECTION: ResurrectionResult = {
  source: "from fastapi import FastAPI\nfrom decimal import Decimal\nfrom typing import Annotated\n\nfrom fastapi import APIRouter, HTTPException\nfrom pydantic import BaseModel, Field\n\n\nclass INVLedger94(BaseModel):\n    txn_id: Annotated[str, Field(max_length=10, json_schema_extra={\"legacy_length\": 10})]\n    sku_code: Annotated[str, Field(max_length=8, json_schema_extra={\"legacy_length\": 8})]\n    # negative_stock (critical)\n    # statistical_outlier (medium)\n    # statistical_outlier (medium)\n    qty_delta: Annotated[int, Field(gt=-1000000, lt=1000000, json_schema_extra={\"legacy_length\": 6})]\n    # orphan_foreign_key (critical)\n    dest_hub_id: Annotated[str, Field(max_length=4, json_schema_extra={\"legacy_length\": 4})]\n\n\nrouter_inv_ledger_94 = APIRouter(prefix='/inv-ledger-94', tags=['/inv-ledger-94'])\nstore_inv_ledger_94: dict[int, INVLedger94] = {}\n\n\n@router_inv_ledger_94.post(\"\", status_code=201)\ndef create_inv_ledger_94(item: INVLedger94) -> dict[str, object]:\n    item_id = max(store_inv_ledger_94, default=0) + 1\n    store_inv_ledger_94[item_id] = item\n    return {\"id\": item_id, \"item\": item}\n\n\n@router_inv_ledger_94.get(\"/{item_id}\")\ndef read_inv_ledger_94(item_id: int) -> INVLedger94:\n    if item_id not in store_inv_ledger_94:\n        raise HTTPException(status_code=404, detail=\"not found\")\n    return store_inv_ledger_94[item_id]\n\n\n@router_inv_ledger_94.get(\"\")\ndef list_inv_ledger_94() -> list[INVLedger94]:\n    return list(store_inv_ledger_94.values())\n\n\n@router_inv_ledger_94.put(\"/{item_id}\")\ndef update_inv_ledger_94(item_id: int, item: INVLedger94) -> INVLedger94:\n    if item_id not in store_inv_ledger_94:\n        raise HTTPException(status_code=404, detail=\"not found\")\n    store_inv_ledger_94[item_id] = item\n    return item\n\n\n@router_inv_ledger_94.delete(\"/{item_id}\", status_code=204)\ndef delete_inv_ledger_94(item_id: int) -> None:\n    if store_inv_ledger_94.pop(item_id, None) is None:\n        raise HTTPException(status_code=404, detail=\"not found\")\n\n\nclass MasterHubsMY(BaseModel):\n    hub_id: Annotated[str, Field(max_length=4, json_schema_extra={\"legacy_length\": 4})]\n    region: Annotated[str, Field(max_length=12, json_schema_extra={\"legacy_length\": 12})]\n\n\nrouter_master_hubs_my = APIRouter(prefix='/master-hubs-my', tags=['/master-hubs-my'])\nstore_master_hubs_my: dict[int, MasterHubsMY] = {}\n\n\n@router_master_hubs_my.post(\"\", status_code=201)\ndef create_master_hubs_my(item: MasterHubsMY) -> dict[str, object]:\n    item_id = max(store_master_hubs_my, default=0) + 1\n    store_master_hubs_my[item_id] = item\n    return {\"id\": item_id, \"item\": item}\n\n\n@router_master_hubs_my.get(\"/{item_id}\")\ndef read_master_hubs_my(item_id: int) -> MasterHubsMY:\n    if item_id not in store_master_hubs_my:\n        raise HTTPException(status_code=404, detail=\"not found\")\n    return store_master_hubs_my[item_id]\n\n\n@router_master_hubs_my.get(\"\")\ndef list_master_hubs_my() -> list[MasterHubsMY]:\n    return list(store_master_hubs_my.values())\n\n\n@router_master_hubs_my.put(\"/{item_id}\")\ndef update_master_hubs_my(item_id: int, item: MasterHubsMY) -> MasterHubsMY:\n    if item_id not in store_master_hubs_my:\n        raise HTTPException(status_code=404, detail=\"not found\")\n    store_master_hubs_my[item_id] = item\n    return item\n\n\n@router_master_hubs_my.delete(\"/{item_id}\", status_code=204)\ndef delete_master_hubs_my(item_id: int) -> None:\n    if store_master_hubs_my.pop(item_id, None) is None:\n        raise HTTPException(status_code=404, detail=\"not found\")\n\n\nclass POSPriceTier(BaseModel):\n    sku_code: Annotated[str, Field(max_length=8, json_schema_extra={\"legacy_length\": 8})]\n    # statistical_outlier (medium)\n    # statistical_outlier (medium)\n    unit_price_myr: Annotated[Decimal, Field(max_digits=9, json_schema_extra={\"legacy_length\": 9})]\n\n\nrouter_pos_price_tier = APIRouter(prefix='/pos-price-tier', tags=['/pos-price-tier'])\nstore_pos_price_tier: dict[int, POSPriceTier] = {}\n\n\n@router_pos_price_tier.post(\"\", status_code=201)\ndef create_pos_price_tier(item: POSPriceTier) -> dict[str, object]:\n    item_id = max(store_pos_price_tier, default=0) + 1\n    store_pos_price_tier[item_id] = item\n    return {\"id\": item_id, \"item\": item}\n\n\n@router_pos_price_tier.get(\"/{item_id}\")\ndef read_pos_price_tier(item_id: int) -> POSPriceTier:\n    if item_id not in store_pos_price_tier:\n        raise HTTPException(status_code=404, detail=\"not found\")\n    return store_pos_price_tier[item_id]\n\n\n@router_pos_price_tier.get(\"\")\ndef list_pos_price_tier() -> list[POSPriceTier]:\n    return list(store_pos_price_tier.values())\n\n\n@router_pos_price_tier.put(\"/{item_id}\")\ndef update_pos_price_tier(item_id: int, item: POSPriceTier) -> POSPriceTier:\n    if item_id not in store_pos_price_tier:\n        raise HTTPException(status_code=404, detail=\"not found\")\n    store_pos_price_tier[item_id] = item\n    return item\n\n\n@router_pos_price_tier.delete(\"/{item_id}\", status_code=204)\ndef delete_pos_price_tier(item_id: int) -> None:\n    if store_pos_price_tier.pop(item_id, None) is None:\n        raise HTTPException(status_code=404, detail=\"not found\")\n\n\napp = FastAPI()\napp.include_router(router_inv_ledger_94)\napp.include_router(router_master_hubs_my)\napp.include_router(router_pos_price_tier)\n",
  syntax_ok: true,
  syntax_error: null,
  indexing: { status: "indexed", record_count: 4820 + 42 + 1190 },
  models: ["INVLedger94", "MasterHubsMY", "POSPriceTier"],
};

import type { SceneEdge, SceneEntity, SceneGraph } from "@/lib/scene/AutopsyScene";
import type {
  Anomaly,
  BoundingBox,
  DefectType,
  MlResult,
  NodeName,
  NodeState,
  ResurrectionResult,
  RotResult,
  SchemaPayload,
  SearchHit,
  SessionEvent,
  Severity,
  VisionResult,
} from "@/types/autopsy";

export const NODE_ORDER: readonly NodeName[] = [
  "vision_extractor",
  "schema_archaeologist",
  "ml_rot_scorer",
  "rot_detector",
  "api_resurrector",
];

export const LOW_CONFIDENCE_THRESHOLD = 0.6;

export type NodeStatus = NodeState | "pending";
export type Phase = "idle" | "running" | "completed" | "failed";
export type Connection =
  | { status: "ok" }
  | { status: "reconnecting"; attempt: number }
  | { status: "lost" };
export type InputKind = "text" | "image";

export interface WorkbenchState {
  phase: Phase;
  nodeStatus: Record<NodeName, NodeStatus>;
  currentNode: NodeName | null;
  vision: VisionResult | null;
  schema: SchemaPayload | null;
  ml: MlResult | null;
  rot: RotResult | null;
  resurrection: ResurrectionResult | null;
  selectedEntityId: string | null;
  searchHits: SearchHit[];
  connection: Connection;
  servedFromCache: boolean;
  inputKind: InputKind | null;
}

export type UiAction =
  | { type: "session_started"; inputKind: InputKind; cached: boolean }
  | { type: "select_entity"; entityId: string | null }
  | { type: "search_results"; hits: SearchHit[] }
  | { type: "connection_ok" }
  | { type: "connection_reconnecting"; attempt: number }
  | { type: "connection_lost" }
  | { type: "reset" };

function pendingStatus(): Record<NodeName, NodeStatus> {
  return {
    vision_extractor: "pending",
    schema_archaeologist: "pending",
    ml_rot_scorer: "pending",
    rot_detector: "pending",
    api_resurrector: "pending",
  };
}

export function initialState(): WorkbenchState {
  return {
    phase: "idle",
    nodeStatus: pendingStatus(),
    currentNode: null,
    vision: null,
    schema: null,
    ml: null,
    rot: null,
    resurrection: null,
    selectedEntityId: null,
    searchHits: [],
    connection: { status: "ok" },
    servedFromCache: false,
    inputKind: null,
  };
}

function failNode(state: WorkbenchState, node: NodeName): WorkbenchState {
  const nodeStatus = { ...state.nodeStatus, [node]: "failed" as const };
  // Resurrection is generated from rot_detector output, so it cannot run without it.
  if (node === "rot_detector" && nodeStatus.api_resurrector === "pending") {
    nodeStatus.api_resurrector = "skipped";
  }
  return {
    ...state,
    nodeStatus,
    currentNode: state.currentNode === node ? null : state.currentNode,
  };
}

function reduceEvent(state: WorkbenchState, event: SessionEvent): WorkbenchState {
  switch (event.type) {
    case "node": {
      const { node } = event;
      if (event.state === "started") {
        return {
          ...state,
          phase: "running",
          currentNode: node,
          nodeStatus: { ...state.nodeStatus, [node]: "started" },
        };
      }
      if (event.state === "skipped") {
        return {
          ...state,
          currentNode: state.currentNode === node ? null : state.currentNode,
          nodeStatus: { ...state.nodeStatus, [node]: "skipped" },
        };
      }
      if (event.state === "failed") return failNode(state, node);
      const next: WorkbenchState = {
        ...state,
        currentNode: state.currentNode === node ? null : state.currentNode,
        nodeStatus: { ...state.nodeStatus, [node]: "completed" },
      };
      switch (event.node) {
        case "vision_extractor":
          return { ...next, vision: event.payload };
        case "schema_archaeologist":
          return { ...next, schema: event.payload };
        case "ml_rot_scorer":
          return { ...next, ml: event.payload };
        case "rot_detector":
          return { ...next, rot: event.payload };
        case "api_resurrector":
          return { ...next, resurrection: event.payload };
        default:
          return next;
      }
    }
    case "error":
      return failNode(state, event.payload.node);
    case "terminal":
      return {
        ...state,
        phase: event.payload.status,
        currentNode: null,
      };
    case "fallback":
      return state;
  }
}

export function sessionReducer(
  state: WorkbenchState,
  action: SessionEvent | UiAction,
): WorkbenchState {
  if (action.type === "node" || action.type === "error" || action.type === "terminal" || action.type === "fallback") {
    return reduceEvent(state, action as SessionEvent);
  }
  const ui = action as UiAction;
  switch (ui.type) {
    case "session_started":
      return {
        ...initialState(),
        phase: "running",
        inputKind: ui.inputKind,
        servedFromCache: ui.cached,
      };
    case "select_entity":
      return { ...state, selectedEntityId: ui.entityId };
    case "search_results":
      return { ...state, searchHits: ui.hits };
    case "connection_ok":
      return { ...state, connection: { status: "ok" } };
    case "connection_reconnecting":
      return { ...state, connection: { status: "reconnecting", attempt: ui.attempt } };
    case "connection_lost":
      return { ...state, connection: { status: "lost" } };
    case "reset":
      return initialState();
  }
}

const SEVERITY_RANK: Record<Severity, number> = { low: 1, medium: 2, critical: 3 };

export function allAnomalies(state: Pick<WorkbenchState, "ml" | "rot">): Anomaly[] {
  return [...(state.rot?.anomalies ?? []), ...(state.ml?.anomalies ?? [])];
}

export function anomaliesByEntity(anomalies: Anomaly[]): Map<string, Anomaly[]> {
  const out = new Map<string, Anomaly[]>();
  for (const a of anomalies) {
    const list = out.get(a.entity);
    if (list) list.push(a);
    else out.set(a.entity, [a]);
  }
  return out;
}

export function entitySeverity(anomalies: Anomaly[], entity: string): Severity | null {
  let best: Severity | null = null;
  for (const a of anomalies) {
    if (a.entity !== entity) continue;
    if (best === null || SEVERITY_RANK[a.severity] > SEVERITY_RANK[best]) best = a.severity;
  }
  return best;
}

export interface FlaggedRegion {
  row: number;
  col: number;
  bbox: BoundingBox;
  confidence: number;
  text: string;
  defectType: DefectType | null;
}

export function flaggedRegions(vision: VisionResult | null): FlaggedRegion[] {
  if (!vision) return [];
  const defects = new Map(vision.defects.map((d) => [`${d.row}:${d.col}`, d]));
  const seen = new Set<string>();
  const out: FlaggedRegion[] = [];
  for (const cell of vision.cells) {
    const key = `${cell.row}:${cell.col}`;
    const defect = defects.get(key) ?? null;
    if (cell.confidence < LOW_CONFIDENCE_THRESHOLD || defect) {
      seen.add(key);
      out.push({
        row: cell.row,
        col: cell.col,
        bbox: cell.bbox,
        confidence: cell.confidence,
        text: cell.text,
        defectType: defect?.type ?? null,
      });
    }
  }
  for (const d of vision.defects) {
    if (seen.has(`${d.row}:${d.col}`)) continue;
    out.push({
      row: d.row,
      col: d.col,
      bbox: d.bbox,
      confidence: d.confidence,
      text: "",
      defectType: d.type,
    });
  }
  return out.sort((a, b) => a.row - b.row || a.col - b.col);
}

/** Entity IDs in the scene are entity names. */
export function toSceneGraph(
  schema: SchemaPayload | null,
  ml: MlResult | null,
  rot: RotResult | null,
): SceneGraph {
  if (!schema) return { entities: [], edges: [] };
  const anomalies = allAnomalies({ ml, rot });
  const pointsByEntity = new Map<string, NonNullable<SceneEntity["points"]>>();
  for (const p of ml?.points ?? []) {
    const list = pointsByEntity.get(p.entity) ?? [];
    list.push({ x: p.x, y: p.y, z: p.z, flagged: p.flagged });
    pointsByEntity.set(p.entity, list);
  }
  const entities: SceneEntity[] = schema.entities.map((e) => {
    const points = pointsByEntity.get(e.name);
    const entity: SceneEntity = {
      id: e.name,
      name: e.name,
      severity: entitySeverity(anomalies, e.name),
    };
    if (points) entity.points = points;
    return entity;
  });
  const known = new Set(entities.map((e) => e.id));
  const edges: SceneEdge[] = [];
  for (const e of schema.entities) {
    for (const fk of e.foreign_keys) {
      if (!known.has(fk.target_entity)) continue;
      const critical = anomalies.some(
        (a) =>
          a.name === "orphan_foreign_key" &&
          a.entity === e.name &&
          a.severity === "critical" &&
          (a.field === null || a.field === fk.source_field),
      );
      edges.push({ sourceId: e.name, targetId: fk.target_entity, critical });
    }
  }
  return { entities, edges };
}

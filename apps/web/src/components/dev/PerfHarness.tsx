"use client";

import { useMemo } from "react";
import { AutopsyCanvasDynamic } from "@/components/autopsy/AutopsyCanvas";
import { LiveAnnouncer, useAnnounce } from "@/components/autopsy/LiveAnnouncer";
import { VisionXRayOverlay } from "@/components/autopsy/VisionXRayOverlay";
import { mulberry32 } from "@/lib/scene/layout";
import type { SceneGraph } from "@/lib/scene/AutopsyScene";
import type { DefectType, Entity, VisionCell, VisionDefect } from "@/types/autopsy";

export const PERF_NODE_COUNT = 50;
export const PERF_POINT_COUNT = 5_000;
export const PERF_GRID = 100;
const CELL_W = 20;
const CELL_H = 14;
const DEFECTS: DefectType[] = ["smudged_digit", "torn_total", "misaligned_column"];

function buildScene(): { entities: Entity[]; graph: SceneGraph } {
  const rand = mulberry32(5000);
  const perEntity = PERF_POINT_COUNT / PERF_NODE_COUNT;
  const entities: Entity[] = [];
  const graph: SceneGraph = { entities: [], edges: [] };
  for (let i = 0; i < PERF_NODE_COUNT; i++) {
    const name = `PERF_${String(i).padStart(2, "0")}`;
    entities.push({
      name,
      position_unit: "column",
      fields: [],
      primary_key: { field: null, confidence: 0 },
      foreign_keys: [],
      row_count: perEntity,
      record_length: null,
    });
    graph.entities.push({
      id: name,
      name,
      severity: i % 5 === 0 ? "critical" : null,
      points: Array.from({ length: perEntity }, (_, p) => ({
        x: rand() * 2 - 1,
        y: rand() * 2 - 1,
        z: rand() * 2 - 1,
        flagged: p % 10 === 0,
      })),
    });
    if (i > 0) graph.edges.push({ sourceId: name, targetId: `PERF_${String(i - 1).padStart(2, "0")}`, critical: i % 5 === 0 });
  }
  return { entities, graph };
}

function buildBoxes(): { cells: VisionCell[]; defects: VisionDefect[] } {
  const cells: VisionCell[] = [];
  const defects: VisionDefect[] = [];
  for (let row = 0; row < PERF_GRID; row++) {
    for (let col = 0; col < PERF_GRID; col++) {
      const i = row * PERF_GRID + col;
      const bbox = { x: col * CELL_W, y: row * CELL_H, width: CELL_W - 2, height: CELL_H - 2 };
      const confidence = i % 13 === 0 ? 0.4 : 0.92;
      cells.push({ row, col, text: String(i), bbox, confidence, smudged: false });
      if (i % 97 === 0) defects.push({ type: DEFECTS[i % 3] as DefectType, row, col, bbox, confidence });
    }
  }
  return { cells, defects };
}

const IMAGE_W = PERF_GRID * CELL_W;
const IMAGE_H = PERF_GRID * CELL_H;
const IMAGE_URI = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${IMAGE_W}" height="${IMAGE_H}"><rect width="100%" height="100%" fill="#e7e0c9"/></svg>`,
)}`;

function Harness({ mode }: { mode: "scene" | "xray" }) {
  const announce = useAnnounce();
  const scene = useMemo(() => (mode === "scene" ? buildScene() : null), [mode]);
  const boxes = useMemo(() => (mode === "xray" ? buildBoxes() : null), [mode]);
  return (
    <main className="p-4">
      <h1 className="sr-only">Rendering harness</h1>
      {scene && (
        <div style={{ height: 600 }}>
          <AutopsyCanvasDynamic
            entities={scene.entities}
            anomalies={[]}
            graph={scene.graph}
            onSelect={() => {}}
            onOpenEntity={() => {}}
          />
        </div>
      )}
      {boxes && (
        <VisionXRayOverlay
          imageUrl={IMAGE_URI}
          imageWidth={IMAGE_W}
          imageHeight={IMAGE_H}
          cells={boxes.cells}
          defects={boxes.defects}
          onAnnounce={announce}
        />
      )}
    </main>
  );
}

export function PerfHarness({ mode }: { mode: "scene" | "xray" }) {
  return (
    <LiveAnnouncer>
      <Harness mode={mode} />
    </LiveAnnouncer>
  );
}

"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { VisionXRayOverlay } from "@/components/autopsy/VisionXRayOverlay";
import { AutopsyScene, type SceneGraph } from "@/lib/scene/AutopsyScene";
import type { VisionCell } from "@/types/autopsy";

const BOX_COUNT = 10_000;
const NODE_COUNT = 50;
const POINTS_PER_NODE = 100;
const FRAME_SAMPLE_MS = 2000;
const COLS = 100;
const WIDTH = 4000;
const HEIGHT = 4000;

function buildCells(): VisionCell[] {
  return Array.from({ length: BOX_COUNT }, (_, i) => ({
    row: Math.floor(i / COLS),
    col: i % COLS,
    text: `v${i}`,
    bbox: { x: (i % COLS) * 40, y: Math.floor(i / COLS) * 40, width: 36, height: 36 },
    confidence: i % 50 === 0 ? 0.3 : 0.95,
    smudged: false,
  }));
}

function buildGraph(): SceneGraph {
  return {
    entities: Array.from({ length: NODE_COUNT }, (_, n) => ({
      id: `n${n}`,
      name: `NODE_${n}`,
      severity: n % 10 === 0 ? "critical" : null,
      points: Array.from({ length: POINTS_PER_NODE }, (_, p) => ({
        x: Math.sin(p + n),
        y: Math.cos(p * 1.3 + n),
        z: Math.sin(p * 0.7),
        flagged: p % 20 === 0,
      })),
    })),
    edges: [],
  };
}

function FpsProbe() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [fps, setFps] = useState<number | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let scene: AutopsyScene;
    try {
      scene = new AutopsyScene(canvas, { reducedMotion: false, onSelect: () => {} });
    } catch {
      setFps(-1);
      return;
    }
    scene.setGraph(buildGraph());
    let frames = 0;
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      frames += 1;
      if (now - start >= FRAME_SAMPLE_MS) {
        setFps(Math.round((frames * 1000) / (now - start)));
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      scene.dispose();
    };
  }, []);
  return (
    <div style={{ height: 400 }}>
      <canvas ref={canvasRef} role="img" aria-label="Stress scene with 50 nodes and 5,000 points" className="h-full w-full" />
      <p data-testid="fps" data-fps={fps ?? ""}>
        {fps === null ? "Measuring frame rate" : `Frame rate ${fps} fps`}
      </p>
    </div>
  );
}

export function StressHarness() {
  const cells = useMemo(buildCells, []);
  return (
    <main className="flex flex-col gap-4 p-4">
      <h1>Rendering stress harness</h1>
      <VisionXRayOverlay
        imageUrl="data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='4000' height='4000'%3E%3C/svg%3E"
        imageWidth={WIDTH}
        imageHeight={HEIGHT}
        cells={cells}
        defects={[]}
        onAnnounce={() => {}}
      />
      <FpsProbe />
    </main>
  );
}

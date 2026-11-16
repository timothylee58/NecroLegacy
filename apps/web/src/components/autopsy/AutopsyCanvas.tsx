"use client";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { AutopsyScene, type SceneGraph } from "@/lib/scene/AutopsyScene";
import { isWebGLAvailable } from "@/lib/scene/webgl";
import type { Anomaly, Entity } from "@/types/autopsy";
import { EntityList } from "./EntityList";

export interface AutopsyCanvasProps {
  entities: Entity[];
  anomalies: Anomaly[];
  graph: SceneGraph;
  highlightedIds?: string[];
  summaryId?: string;
  onSelect: (entityId: string) => void;
  onOpenEntity: (entityName: string, opener: HTMLButtonElement) => void;
}

const CANVAS_LABEL = "3D autopsy view of entities and their anomalies";
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.(REDUCED_MOTION_QUERY).matches === true;
}

function AutopsyCanvasImpl({
  entities,
  anomalies,
  graph,
  highlightedIds = [],
  summaryId = "autopsy-summary",
  onSelect,
  onOpenEntity,
}: AutopsyCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const summaryIdRef = useRef(summaryId);
  summaryIdRef.current = summaryId;
  const sceneRef = useRef<AutopsyScene | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const [unavailable, setUnavailable] = useState(false);
  const empty = entities.length === 0;
  const showCanvas = !empty && !unavailable;

  useEffect(() => {
    if (!showCanvas) return;
    const host = hostRef.current;
    if (!host) return;
    if (!isWebGLAvailable()) {
      setUnavailable(true);
      return;
    }
    // A disposed scene force-loses its WebGL context, so a reused canvas (Strict Mode remount) would be dead.
    const canvas = document.createElement("canvas");
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", CANVAS_LABEL);
    canvas.setAttribute("aria-describedby", summaryIdRef.current);
    canvas.className = "block h-full w-full";
    host.appendChild(canvas);
    let scene: AutopsyScene;
    try {
      scene = new AutopsyScene(canvas, {
        reducedMotion: prefersReducedMotion(),
        onSelect: (id) => onSelectRef.current(id),
        onContextLost: () => setUnavailable(true),
      });
    } catch {
      canvas.remove();
      setUnavailable(true);
      return;
    }
    sceneRef.current = scene;
    scene.setGraph(graphRef.current);

    const mql = window.matchMedia?.(REDUCED_MOTION_QUERY);
    const onChange = (e: MediaQueryListEvent) => scene.setReducedMotion(e.matches);
    mql?.addEventListener("change", onChange);
    return () => {
      mql?.removeEventListener("change", onChange);
      scene.dispose();
      canvas.remove();
      sceneRef.current = null;
    };
  }, [showCanvas]);

  useEffect(() => {
    hostRef.current?.querySelector("canvas")?.setAttribute("aria-describedby", summaryId);
  }, [summaryId]);
  useEffect(() => {
    sceneRef.current?.setGraph(graph);
  }, [graph]);

  const highlightKey = highlightedIds.join("\u0000");
  useEffect(() => {
    sceneRef.current?.setHighlights(highlightKey ? highlightKey.split("\u0000") : []);
  }, [highlightKey]);

  if (empty) {
    return (
      <p role="status" className="rounded-md border px-3 py-6 text-center">
        No entities to display.
      </p>
    );
  }

  if (unavailable) {
    return (
      <div className="flex flex-col gap-3">
        <p role="status">3D rendering is unavailable</p>
        <EntityList entities={entities} anomalies={anomalies} onOpen={onOpenEntity} />
      </div>
    );
  }

  return <div ref={hostRef} className="h-full w-full" />;
}

export const AutopsyCanvasDynamic = dynamic(() => Promise.resolve(AutopsyCanvasImpl), { ssr: false });
export default AutopsyCanvasDynamic;
export { AutopsyCanvasImpl as AutopsyCanvas };

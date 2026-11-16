import * as THREE from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutopsyScene, type SceneGraph } from "./AutopsyScene";

const rendererStub = vi.hoisted(() => ({
  instances: [] as Array<{
    dispose: ReturnType<typeof vi.fn>;
    forceContextLoss: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal<typeof import("three")>();
  class WebGLRenderer {
    dispose = vi.fn();
    forceContextLoss = vi.fn();
    setPixelRatio = vi.fn();
    setSize = vi.fn();
    render = vi.fn();
    constructor() {
      rendererStub.instances.push(this);
    }
  }
  return { ...actual, WebGLRenderer };
});

const point = (flagged: boolean) => ({ x: 0.1, y: 0.2, z: 0.3, flagged });

function graph(criticalSeverity: "critical" | "medium"): SceneGraph {
  return {
    entities: [
      { id: "a", name: "orders", severity: criticalSeverity, points: [point(true), point(false)] },
      { id: "b", name: "customers", severity: null },
      { id: "c", name: "products", severity: null, points: [point(false)] },
    ],
    edges: [
      { sourceId: "a", targetId: "b", critical: true },
      { sourceId: "a", targetId: "c", critical: false },
    ],
  };
}

describe("AutopsyScene disposal", () => {
  const counts = new Map<object, number>();
  const seen = new Set<THREE.BufferGeometry | THREE.Material>();
  let scene: AutopsyScene;

  const bump = (self: object) => counts.set(self, (counts.get(self) ?? 0) + 1);

  // Objects are only visible while attached, so sample the private scene after each mutation.
  const sample = () => {
    const root = (scene as unknown as { scene: THREE.Scene }).scene;
    root.traverse((obj) => {
      const o = obj as THREE.Object3D & {
        geometry?: THREE.BufferGeometry;
        material?: THREE.Material | THREE.Material[];
      };
      if (o.geometry) seen.add(o.geometry);
      for (const m of [o.material ?? []].flat()) seen.add(m);
    });
  };

  beforeEach(() => {
    counts.clear();
    seen.clear();
    rendererStub.instances.length = 0;
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    const geoDispose = THREE.BufferGeometry.prototype.dispose;
    const matDispose = THREE.Material.prototype.dispose;
    vi.spyOn(THREE.BufferGeometry.prototype, "dispose").mockImplementation(function (this: THREE.BufferGeometry) {
      bump(this);
      geoDispose.call(this);
    });
    vi.spyOn(THREE.Material.prototype, "dispose").mockImplementation(function (this: THREE.Material) {
      bump(this);
      matDispose.call(this);
    });
    scene = new AutopsyScene(document.createElement("canvas"), {
      reducedMotion: false,
      onSelect: () => undefined,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("disposes every geometry and material exactly once across setGraph calls and dispose()", () => {
    scene.setGraph(graph("critical"));
    sample();
    scene.setGraph(graph("medium"));
    sample();
    scene.setHighlights(["a", "b"]);
    sample();
    scene.setGraph({ entities: [], edges: [] });
    sample();
    scene.setGraph(graph("critical"));
    scene.setHighlights(["c"]);
    sample();
    scene.setReducedMotion(true);
    sample();

    expect(seen.size).toBeGreaterThan(0);
    scene.dispose();
    scene.dispose();

    for (const resource of seen) {
      expect(counts.get(resource), resource.type).toBe(1);
    }

    const renderer = rendererStub.instances[0]!;
    expect(rendererStub.instances).toHaveLength(1);
    expect(renderer.dispose).toHaveBeenCalledTimes(1);
    expect(renderer.forceContextLoss).toHaveBeenCalledTimes(1);
  });

  it("does not dispose unchanged entities when the same graph is set again", () => {
    scene.setGraph(graph("critical"));
    sample();
    scene.setGraph(graph("critical"));
    expect([...counts.values()]).toHaveLength(0);
    scene.dispose();
    for (const resource of seen) expect(counts.get(resource)).toBe(1);
  });
});

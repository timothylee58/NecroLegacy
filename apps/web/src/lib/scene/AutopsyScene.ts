import * as THREE from "three";
import type { Severity } from "@/types/autopsy";
import { CRIMSON, SLATE } from "./palette";
import { computeLayout, pointPosition, type Vec3 } from "./layout";

export interface ScenePoint {
  x: number;
  y: number;
  z: number;
  flagged: boolean;
}

export interface SceneEntity {
  id: string;
  name: string;
  /** Highest anomaly severity for the entity, or null when it has none. */
  severity: Severity | null;
  points?: ScenePoint[];
}

export interface SceneEdge {
  sourceId: string;
  targetId: string;
  critical: boolean;
}

export interface SceneGraph {
  entities: SceneEntity[];
  edges: SceneEdge[];
}

export interface SceneOptions {
  reducedMotion: boolean;
  onSelect(entityId: string): void;
  onContextLost?(): void;
}

const TEAL = "#14B8A6";
const AMBER = "#F59E0B";
const HIGHLIGHT = "#FFFFFF";
const NODE_RADIUS = 0.5;
const PULSE_PERIOD_S = 2;
const MAX_PIXEL_RATIO = 2;
const CAMERA_DISTANCE = 20;

const ARC_VERTEX = /* glsl */ `
  varying float vT;
  void main() {
    vT = uv.x;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// A bright segment travels along the curve; the rest stays a dim crimson.
const ARC_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform vec3 uColor;
  varying float vT;
  void main() {
    float head = fract(uTime * 0.5);
    float d = abs(vT - head);
    d = min(d, 1.0 - d);
    float glow = smoothstep(0.18, 0.0, d);
    vec3 c = mix(uColor * 0.35, vec3(1.0, 0.6, 0.65), glow);
    gl_FragColor = vec4(c, 0.35 + 0.65 * glow);
  }
`;

type Disposable = { dispose(): void };

function disposeMaterial(material: THREE.Material): void {
  for (const value of Object.values(material)) {
    if (value instanceof THREE.Texture) value.dispose();
  }
  if (material instanceof THREE.ShaderMaterial) {
    for (const u of Object.values(material.uniforms)) {
      if (u.value instanceof THREE.Texture) u.value.dispose();
    }
  }
  material.dispose();
}

function disposeObject(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const o = obj as THREE.Object3D & {
      geometry?: Disposable;
      material?: THREE.Material | THREE.Material[];
    };
    o.geometry?.dispose();
    if (Array.isArray(o.material)) o.material.forEach(disposeMaterial);
    else if (o.material) disposeMaterial(o.material);
  });
}

interface EntityRecord {
  signature: string;
  position: Vec3;
  severity: Severity | null;
  group: THREE.Group;
  node: THREE.Mesh;
  points: THREE.Points | null;
  highlight: THREE.Mesh | null;
}

interface EdgeRecord {
  signature: string;
  group: THREE.Group;
  arcUniforms: { uTime: { value: number } } | null;
}

function nodeColor(severity: Severity | null): string {
  if (severity === "critical") return CRIMSON;
  if (severity === null) return TEAL;
  return AMBER;
}

export class AutopsyScene {
  private readonly canvas: HTMLCanvasElement;
  private readonly opts: SceneOptions;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
  private readonly raycaster = new THREE.Raycaster();
  private readonly entities = new Map<string, EntityRecord>();
  private readonly edges = new Map<string, EdgeRecord>();
  private readonly highlighted = new Set<string>();
  private readonly resizeObserver: ResizeObserver | null;
  private readonly intersectionObserver: IntersectionObserver | null;

  private graph: SceneGraph = { entities: [], edges: [] };
  private reducedMotion: boolean;
  private visible = true;
  private intersecting = true;
  private disposed = false;
  private rafId: number | null = null;
  private startMs = performance.now();

  constructor(canvas: HTMLCanvasElement, opts: SceneOptions) {
    this.canvas = canvas;
    this.opts = opts;
    this.reducedMotion = opts.reducedMotion;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(
      Math.min(typeof window === "undefined" ? 1 : window.devicePixelRatio || 1, MAX_PIXEL_RATIO),
    );
    this.camera.position.set(0, 0, CAMERA_DISTANCE);
    this.raycaster.params.Points = { threshold: 0.3 };

    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("webglcontextlost", this.onContextLost);
    document.addEventListener("visibilitychange", this.onVisibility);
    this.visible = document.visibilityState !== "hidden";

    this.resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            const el = this.canvas.parentElement ?? this.canvas;
            this.resize(el.clientWidth, el.clientHeight, window.devicePixelRatio || 1);
          });
    this.resizeObserver?.observe(canvas.parentElement ?? canvas);

    this.intersectionObserver =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver((entries) => {
            const last = entries[entries.length - 1];
            if (!last) return;
            this.intersecting = last.isIntersecting;
            this.syncLoop();
          });
    this.intersectionObserver?.observe(canvas);

    const el = canvas.parentElement ?? canvas;
    if (el.clientWidth > 0 && el.clientHeight > 0) {
      this.resize(el.clientWidth, el.clientHeight, window.devicePixelRatio || 1);
    }
    this.syncLoop();
  }

  setGraph(g: SceneGraph): void {
    if (this.disposed) return;
    this.graph = g;
    this.applyGraph();
    this.requestRender();
  }

  setHighlights(entityIds: string[]): void {
    if (this.disposed) return;
    this.highlighted.clear();
    for (const id of entityIds) this.highlighted.add(id);
    this.applyHighlights();
    this.requestRender();
  }

  setReducedMotion(v: boolean): void {
    if (this.disposed || v === this.reducedMotion) return;
    this.reducedMotion = v;
    // Decorations differ per mode, so every object is rebuilt.
    this.clearAll();
    this.applyGraph();
    this.syncLoop();
    this.requestRender();
  }

  resize(width: number, height: number, dpr: number): void {
    if (this.disposed || width <= 0 || height <= 0) return;
    this.renderer.setPixelRatio(Math.min(dpr, MAX_PIXEL_RATIO));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.resizeObserver?.disconnect();
    this.intersectionObserver?.disconnect();
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    document.removeEventListener("visibilitychange", this.onVisibility);

    this.clearAll();
    this.scene.traverse((obj) => {
      if (obj === this.scene) return;
      // Anything left over was added outside the tracked records.
      disposeObject(obj);
    });
    this.scene.clear();
    this.highlighted.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  private applyGraph(): void {
    const { entities, edges } = this.graph;
    const positions = computeLayout(
      entities.map((e) => e.name),
      edges.flatMap((e) => {
        const s = entities.find((x) => x.id === e.sourceId);
        const t = entities.find((x) => x.id === e.targetId);
        return s && t ? [{ source: s.name, target: t.name }] : [];
      }),
    );

    const liveIds = new Set(entities.map((e) => e.id));
    for (const [id, rec] of this.entities) {
      if (!liveIds.has(id)) this.removeEntity(id, rec);
    }

    for (const entity of entities) {
      const position = positions.get(entity.name) ?? ([0, 0, 0] as Vec3);
      const signature = [
        entity.severity ?? "none",
        position.join(","),
        (entity.points ?? []).map((p) => `${p.x},${p.y},${p.z},${p.flagged ? 1 : 0}`).join(";"),
      ].join("|");
      const existing = this.entities.get(entity.id);
      if (existing?.signature === signature) continue;
      if (existing) this.removeEntity(entity.id, existing);
      this.entities.set(entity.id, this.buildEntity(entity, position, signature));
    }

    const liveEdgeKeys = new Set<string>();
    for (const edge of edges) {
      const a = this.entities.get(edge.sourceId);
      const b = this.entities.get(edge.targetId);
      if (!a || !b) continue;
      const key = `${edge.sourceId}->${edge.targetId}`;
      liveEdgeKeys.add(key);
      const signature = `${edge.critical}|${a.position.join(",")}|${b.position.join(",")}`;
      const existing = this.edges.get(key);
      if (existing?.signature === signature) continue;
      if (existing) this.removeEdge(key, existing);
      this.edges.set(key, this.buildEdge(edge, a.position, b.position, signature));
    }
    for (const [key, rec] of this.edges) {
      if (!liveEdgeKeys.has(key)) this.removeEdge(key, rec);
    }

    this.applyHighlights();
  }

  private buildEntity(entity: SceneEntity, position: Vec3, signature: string): EntityRecord {
    const group = new THREE.Group();
    group.position.set(...position);

    const node = new THREE.Mesh(
      new THREE.SphereGeometry(NODE_RADIUS, 24, 16),
      new THREE.MeshBasicMaterial({ color: nodeColor(entity.severity) }),
    );
    node.userData.entityId = entity.id;
    group.add(node);

    if (this.reducedMotion) {
      if (entity.severity === null) {
        const halo = new THREE.Mesh(
          new THREE.RingGeometry(NODE_RADIUS + 0.18, NODE_RADIUS + 0.24, 48),
          new THREE.MeshBasicMaterial({ color: TEAL, side: THREE.DoubleSide }),
        );
        halo.lookAt(this.camera.position.clone().sub(group.position));
        group.add(halo);
      } else if (entity.severity === "critical") {
        const diamond = new THREE.Mesh(
          new THREE.OctahedronGeometry(0.28),
          new THREE.MeshBasicMaterial({ color: CRIMSON }),
        );
        diamond.position.set(0, NODE_RADIUS + 0.55, 0);
        group.add(diamond);
      }
    }

    let points: THREE.Points | null = null;
    if (entity.points && entity.points.length > 0) {
      const positionsArr = new Float32Array(entity.points.length * 3);
      const colors = new Float32Array(entity.points.length * 3);
      const crimson = new THREE.Color(CRIMSON);
      const slate = new THREE.Color(SLATE);
      entity.points.forEach((p, i) => {
        const [px, py, pz] = pointPosition(position, [p.x, p.y, p.z]);
        positionsArr.set([px, py, pz], i * 3);
        (p.flagged ? crimson : slate).toArray(colors, i * 3);
      });
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(positionsArr, 3));
      geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      points = new THREE.Points(
        geometry,
        new THREE.PointsMaterial({ size: 0.12, vertexColors: true, sizeAttenuation: true }),
      );
      points.userData.entityId = entity.id;
      // Points are in world space, so they live on the scene, not the node group.
      this.scene.add(points);
    }

    this.scene.add(group);
    return { signature, position, severity: entity.severity, group, node, points, highlight: null };
  }

  private buildEdge(edge: SceneEdge, from: Vec3, to: Vec3, signature: string): EdgeRecord {
    const group = new THREE.Group();
    const a = new THREE.Vector3(...from);
    const b = new THREE.Vector3(...to);

    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([a, b]),
      new THREE.LineBasicMaterial({ color: edge.critical ? CRIMSON : SLATE, transparent: true, opacity: 0.6 }),
    );
    group.add(line);

    let arcUniforms: EdgeRecord["arcUniforms"] = null;
    if (edge.critical) {
      const mid = a.clone().add(b).multiplyScalar(0.5);
      const span = a.distanceTo(b);
      // Offset perpendicular to the edge so the arc is distinguishable from the straight line.
      const dir = b.clone().sub(a).normalize();
      const up = Math.abs(dir.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
      const side = new THREE.Vector3().crossVectors(dir, up).normalize();
      mid.addScaledVector(side, Math.max(span * 0.25, 0.5));
      const curve = new THREE.QuadraticBezierCurve3(a, mid, b);

      if (this.reducedMotion) {
        group.add(
          new THREE.Mesh(
            new THREE.TubeGeometry(curve, 32, 0.14, 8, false),
            new THREE.MeshBasicMaterial({ color: CRIMSON }),
          ),
        );
      } else {
        const uniforms = { uTime: { value: 0 }, uColor: { value: new THREE.Color(CRIMSON) } };
        arcUniforms = uniforms;
        group.add(
          new THREE.Mesh(
            new THREE.TubeGeometry(curve, 48, 0.05, 6, false),
            new THREE.ShaderMaterial({
              uniforms,
              vertexShader: ARC_VERTEX,
              fragmentShader: ARC_FRAGMENT,
              transparent: true,
              depthWrite: false,
            }),
          ),
        );
      }
    }

    this.scene.add(group);
    return { signature, group, arcUniforms };
  }

  private removeEntity(id: string, rec: EntityRecord): void {
    this.detach(rec.group);
    if (rec.points) this.detach(rec.points);
    this.entities.delete(id);
  }

  private removeEdge(key: string, rec: EdgeRecord): void {
    this.detach(rec.group);
    this.edges.delete(key);
  }

  private detach(obj: THREE.Object3D): void {
    this.scene.remove(obj);
    disposeObject(obj);
  }

  private clearAll(): void {
    for (const [id, rec] of [...this.entities]) this.removeEntity(id, rec);
    for (const [key, rec] of [...this.edges]) this.removeEdge(key, rec);
  }

  private applyHighlights(): void {
    for (const [id, rec] of this.entities) {
      const on = this.highlighted.has(id);
      if (on && !rec.highlight) {
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(NODE_RADIUS + 0.35, NODE_RADIUS + 0.45, 48),
          new THREE.MeshBasicMaterial({ color: HIGHLIGHT, side: THREE.DoubleSide }),
        );
        ring.lookAt(this.camera.position.clone().sub(rec.group.position));
        rec.group.add(ring);
        rec.highlight = ring;
      } else if (!on && rec.highlight) {
        rec.group.remove(rec.highlight);
        disposeObject(rec.highlight);
        rec.highlight = null;
      }
    }
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (this.disposed) return;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -(((event.clientY - rect.top) / rect.height) * 2 - 1),
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const targets: THREE.Object3D[] = [];
    for (const rec of this.entities.values()) {
      targets.push(rec.node);
      if (rec.points) targets.push(rec.points);
    }
    const hit = this.raycaster.intersectObjects(targets, false)[0];
    const id = hit?.object.userData.entityId;
    if (typeof id === "string") this.opts.onSelect(id);
  };

  private readonly onContextLost = (event: Event): void => {
    event.preventDefault();
    this.opts.onContextLost?.();
  };

  private readonly onVisibility = (): void => {
    this.visible = document.visibilityState !== "hidden";
    this.syncLoop();
  };

  private syncLoop(): void {
    const shouldRun = !this.disposed && !this.reducedMotion && this.visible && this.intersecting;
    if (!shouldRun) {
      if (this.rafId !== null) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
      return;
    }
    if (this.rafId === null) this.rafId = requestAnimationFrame(this.tick);
  }

  private requestRender(): void {
    if (this.disposed || !this.visible || !this.intersecting) return;
    if (!this.reducedMotion) {
      this.syncLoop();
      return;
    }
    if (this.rafId === null) {
      this.rafId = requestAnimationFrame(() => {
        this.rafId = null;
        this.renderFrame(0);
      });
    }
  }

  private readonly tick = (): void => {
    this.rafId = null;
    if (this.disposed) return;
    this.renderFrame((performance.now() - this.startMs) / 1000);
    this.syncLoop();
  };

  private renderFrame(t: number): void {
    for (const rec of this.entities.values()) {
      const base = this.highlighted.has(rec.node.userData.entityId) ? 1.25 : 1;
      const pulse =
        !this.reducedMotion && rec.severity === null
          ? 1 + 0.08 * Math.sin((2 * Math.PI * t) / PULSE_PERIOD_S)
          : 1;
      rec.node.scale.setScalar(base * pulse);
    }
    for (const rec of this.edges.values()) {
      if (rec.arcUniforms) rec.arcUniforms.uTime.value = t;
    }
    this.renderer.render(this.scene, this.camera);
  }
}

export type Vec3 = readonly [number, number, number];

export interface LayoutEdge {
  source: string;
  target: string;
}

export const LAYOUT_ITERATIONS = 200;
export const SPHERE_RADIUS = 6;
export const POINT_SCALE = 1.5;

export function hashNames(names: readonly string[]): number {
  let h = 2166136261;
  for (const name of names) {
    for (let i = 0; i < name.length; i++) {
      h ^= name.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    // Separator so ["ab","c"] and ["a","bc"] hash differently.
    h ^= 0xff;
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pointPosition(node: Vec3, coords: Vec3): Vec3 {
  return [
    node[0] + POINT_SCALE * coords[0],
    node[1] + POINT_SCALE * coords[1],
    node[2] + POINT_SCALE * coords[2],
  ];
}

interface Body {
  p: [number, number, number];
  f: [number, number, number];
}

/** Pure, deterministic for a given ordered name list and edge list. */
export function computeLayout(
  entityNames: readonly string[],
  edges: readonly LayoutEdge[] = [],
): Map<string, Vec3> {
  const n = entityNames.length;
  const result = new Map<string, Vec3>();
  if (n === 0) return result;
  if (n === 1) {
    result.set(entityNames[0] as string, [0, 0, 0]);
    return result;
  }

  const rand = mulberry32(hashNames(entityNames));
  const bodies: Body[] = entityNames.map(() => ({
    p: [
      (rand() * 2 - 1) * SPHERE_RADIUS,
      (rand() * 2 - 1) * SPHERE_RADIUS,
      (rand() * 2 - 1) * SPHERE_RADIUS,
    ],
    f: [0, 0, 0],
  }));

  const index = new Map<string, number>();
  entityNames.forEach((name, i) => index.set(name, i));
  const links: Array<[Body, Body]> = [];
  for (const e of edges) {
    const s = index.get(e.source);
    const t = index.get(e.target);
    const a = s === undefined ? undefined : bodies[s];
    const b = t === undefined ? undefined : bodies[t];
    if (a && b && a !== b) links.push([a, b]);
  }

  const k = SPHERE_RADIUS;
  for (let iter = 0; iter < LAYOUT_ITERATIONS; iter++) {
    const temp = (1 - iter / LAYOUT_ITERATIONS) * 0.5 + 0.01;
    for (const b of bodies) b.f = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const a = bodies[i] as Body;
      for (let j = i + 1; j < n; j++) {
        const b = bodies[j] as Body;
        let dx = a.p[0] - b.p[0];
        let dy = a.p[1] - b.p[1];
        let dz = a.p[2] - b.p[2];
        let d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < 1e-6) {
          dx = rand() - 0.5;
          dy = rand() - 0.5;
          dz = rand() - 0.5;
          d2 = dx * dx + dy * dy + dz * dz + 1e-6;
        }
        const f = (k * k) / d2;
        a.f = [a.f[0] + dx * f, a.f[1] + dy * f, a.f[2] + dz * f];
        b.f = [b.f[0] - dx * f, b.f[1] - dy * f, b.f[2] - dz * f];
      }
    }
    for (const [a, b] of links) {
      const dx = a.p[0] - b.p[0];
      const dy = a.p[1] - b.p[1];
      const dz = a.p[2] - b.p[2];
      const f = Math.sqrt(dx * dx + dy * dy + dz * dz) / k;
      a.f = [a.f[0] - dx * f, a.f[1] - dy * f, a.f[2] - dz * f];
      b.f = [b.f[0] + dx * f, b.f[1] + dy * f, b.f[2] + dz * f];
    }
    for (const b of bodies) {
      // Weak pull to the origin keeps disconnected nodes from drifting apart.
      const fx = b.f[0] - b.p[0] * 0.05;
      const fy = b.f[1] - b.p[1] * 0.05;
      const fz = b.f[2] - b.p[2] * 0.05;
      const mag = Math.sqrt(fx * fx + fy * fy + fz * fz) || 1;
      const step = Math.min(mag, temp * k) / mag;
      b.p = [b.p[0] + fx * step, b.p[1] + fy * step, b.p[2] + fz * step];
    }
  }

  let maxR = 0;
  for (const b of bodies) maxR = Math.max(maxR, Math.hypot(b.p[0], b.p[1], b.p[2]));
  const scale = maxR > 0 ? SPHERE_RADIUS / maxR : 1;
  entityNames.forEach((name, i) => {
    const b = bodies[i] as Body;
    result.set(name, [b.p[0] * scale, b.p[1] * scale, b.p[2] * scale]);
  });
  return result;
}

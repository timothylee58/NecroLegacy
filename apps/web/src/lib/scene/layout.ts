type DenseArray = Float64Array & { [i: number]: number };

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

/** Pure, deterministic for a given ordered name list and edge list. */
export function computeLayout(
  entityNames: readonly string[],
  edges: readonly LayoutEdge[] = [],
): Map<string, Vec3> {
  const n = entityNames.length;
  const result = new Map<string, Vec3>();
  if (n === 0) return result;
  if (n === 1) {
    result.set(first, [0, 0, 0]);
    return result;
  }

  const rand = mulberry32(hashNames(entityNames));
  const first = entityNames[0] as string;
  const pos = new Float64Array(n * 3) as DenseArray;
  for (let i = 0; i < n * 3; i++) pos[i] = (rand() * 2 - 1) * SPHERE_RADIUS;

  const index = new Map<string, number>();
  entityNames.forEach((name, i) => index.set(name, i));
  const links: Array<[number, number]> = [];
  for (const e of edges) {
    const s = index.get(e.source);
    const t = index.get(e.target);
    if (s !== undefined && t !== undefined && s !== t) links.push([s, t]);
  }

  const k = SPHERE_RADIUS;
  const force = new Float64Array(n * 3) as DenseArray;
  for (let iter = 0; iter < LAYOUT_ITERATIONS; iter++) {
    const temp = (1 - iter / LAYOUT_ITERATIONS) * 0.5 + 0.01;
    force.fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = pos[i * 3] - pos[j * 3];
        let dy = pos[i * 3 + 1] - pos[j * 3 + 1];
        let dz = pos[i * 3 + 2] - pos[j * 3 + 2];
        let d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < 1e-6) {
          dx = rand() - 0.5;
          dy = rand() - 0.5;
          dz = rand() - 0.5;
          d2 = dx * dx + dy * dy + dz * dz + 1e-6;
        }
        const f = (k * k) / d2;
        force[i * 3] += dx * f;
        force[i * 3 + 1] += dy * f;
        force[i * 3 + 2] += dz * f;
        force[j * 3] -= dx * f;
        force[j * 3 + 1] -= dy * f;
        force[j * 3 + 2] -= dz * f;
      }
    }
    for (const [s, t] of links) {
      const dx = pos[s * 3] - pos[t * 3];
      const dy = pos[s * 3 + 1] - pos[t * 3 + 1];
      const dz = pos[s * 3 + 2] - pos[t * 3 + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const f = d / k;
      force[s * 3] -= dx * f;
      force[s * 3 + 1] -= dy * f;
      force[s * 3 + 2] -= dz * f;
      force[t * 3] += dx * f;
      force[t * 3 + 1] += dy * f;
      force[t * 3 + 2] += dz * f;
    }
    for (let i = 0; i < n; i++) {
      // Weak pull to the origin keeps disconnected nodes from drifting apart.
      const fx = force[i * 3] - pos[i * 3] * 0.05;
      const fy = force[i * 3 + 1] - pos[i * 3 + 1] * 0.05;
      const fz = force[i * 3 + 2] - pos[i * 3 + 2] * 0.05;
      const mag = Math.sqrt(fx * fx + fy * fy + fz * fz) || 1;
      const step = Math.min(mag, temp * k) / mag;
      pos[i * 3] += fx * step;
      pos[i * 3 + 1] += fy * step;
      pos[i * 3 + 2] += fz * step;
    }
  }

  let maxR = 0;
  for (let i = 0; i < n; i++) {
    const r = Math.hypot(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    if (r > maxR) maxR = r;
  }
  const scale = maxR > 0 ? SPHERE_RADIUS / maxR : 1;
  entityNames.forEach((name, i) => {
    result.set(name, [pos[i * 3] * scale, pos[i * 3 + 1] * scale, pos[i * 3 + 2] * scale]);
  });
  return result;
}

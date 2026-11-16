import { describe, expect, it } from "vitest";
import {
  computeLayout,
  hashNames,
  POINT_SCALE,
  pointPosition,
  SPHERE_RADIUS,
  type Vec3,
} from "./layout";

const names = ["customers", "orders", "inventory", "products"];
const edges = [
  { source: "orders", target: "customers" },
  { source: "orders", target: "products" },
];

describe("computeLayout determinism (11.5)", () => {
  it("gives identical positions for the same entity names", () => {
    const a = computeLayout(names, edges);
    const b = computeLayout([...names], edges.map((e) => ({ ...e })));
    expect([...b.entries()]).toEqual([...a.entries()]);
  });

  it("returns one finite position per entity within the sphere", () => {
    const layout = computeLayout(names, edges);
    expect([...layout.keys()]).toEqual(names);
    for (const pos of layout.values()) {
      expect(pos.every(Number.isFinite)).toBe(true);
      expect(Math.hypot(...pos)).toBeLessThanOrEqual(SPHERE_RADIUS + 1e-9);
    }
  });

  it("changes the layout when the names change", () => {
    const a = computeLayout(names);
    const b = computeLayout(["a", "b", "c", "d"]);
    expect(hashNames(names)).not.toBe(hashNames(["a", "b", "c", "d"]));
    expect(b.get("a")).not.toEqual(a.get("customers"));
  });

  it("handles empty and single-entity input", () => {
    expect(computeLayout([]).size).toBe(0);
    expect(computeLayout(["only"]).get("only")).toEqual([0, 0, 0]);
  });
});

describe("pointPosition (11.5, 11.7)", () => {
  it("equals node position plus a constant scale times coordinates", () => {
    const node: Vec3 = [1, -2, 3];
    const coords: Vec3 = [0.5, 2, -4];
    expect(POINT_SCALE).toBe(1.5);
    expect(pointPosition(node, coords)).toEqual([
      node[0] + POINT_SCALE * coords[0],
      node[1] + POINT_SCALE * coords[1],
      node[2] + POINT_SCALE * coords[2],
    ]);
  });

  it("places zero coordinates exactly at the node", () => {
    expect(pointPosition([4, 5, 6], [0, 0, 0])).toEqual([4, 5, 6]);
  });

  it("uses the same scale for every point regardless of node", () => {
    const coords: Vec3 = [1, 1, 1];
    const p1 = pointPosition([0, 0, 0], coords);
    const p2 = pointPosition([10, 10, 10], coords);
    expect(p2.map((v, i) => v - (p1[i] as number))).toEqual([10, 10, 10]);
  });
});

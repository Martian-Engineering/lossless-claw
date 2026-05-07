/**
 * Tests for the hierarchical-clustering wrapper.
 *
 * See `src/extraction/hierarchical-cluster.ts` for the rationale on
 * choosing ml-hclust + cosine-distance Ward.
 */

import { describe, expect, it } from "vitest";
import { clusterHierarchical } from "../src/extraction/hierarchical-cluster.js";

/** Build a Float32Array from a plain array literal. */
function f32(values: number[]): Float32Array {
  const arr = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) arr[i] = values[i];
  return arr;
}

/** Number of distinct cluster ids in an assignments array. */
function distinctClusterIds(assignments: { clusterId: number }[]): Set<number> {
  return new Set(assignments.map((a) => a.clusterId));
}

describe("clusterHierarchical", () => {
  it("returns empty result for empty input", () => {
    const result = clusterHierarchical({ vectors: [] });
    expect(result.assignments).toEqual([]);
    expect(result.numClusters).toBe(0);
  });

  it("returns single cluster for a single vector", () => {
    const result = clusterHierarchical({ vectors: [f32([1, 0, 0])] });
    expect(result.assignments).toEqual([{ vectorIndex: 0, clusterId: 0 }]);
    expect(result.numClusters).toBe(1);
  });

  it("groups three identical vectors into one cluster regardless of cutHeight", () => {
    const vectors = [f32([1, 0, 0]), f32([1, 0, 0]), f32([1, 0, 0])];
    // Identical vectors → cosine distance 0 → all merge at height 0
    // → any non-negative cut keeps them together.
    for (const cutHeight of [0.0, 0.01, 0.5, 1.0, 1.9]) {
      const result = clusterHierarchical({ vectors, cutHeight });
      expect(result.numClusters).toBe(1);
      expect(distinctClusterIds(result.assignments).size).toBe(1);
      expect(result.assignments).toHaveLength(3);
      // Every input vector index should appear exactly once.
      const indices = result.assignments.map((a) => a.vectorIndex).sort();
      expect(indices).toEqual([0, 1, 2]);
    }
  });

  it("separates two clearly distinct groups at moderate cutHeight", () => {
    // Five vectors near (1,0,0) and five near (0,1,0). After
    // normalization the inter-group cosine distance is ~1 and the
    // intra-group distance is tiny.
    const vectors = [
      f32([1.0, 0.05, 0.0]),
      f32([0.98, 0.04, 0.01]),
      f32([1.02, 0.06, 0.0]),
      f32([1.0, 0.05, 0.02]),
      f32([0.99, 0.05, 0.0]),
      f32([0.05, 1.0, 0.0]),
      f32([0.04, 0.98, 0.01]),
      f32([0.06, 1.02, 0.0]),
      f32([0.05, 1.0, 0.02]),
      f32([0.05, 0.99, 0.0]),
    ];
    const result = clusterHierarchical({ vectors, cutHeight: 0.5 });
    expect(result.numClusters).toBe(2);
    // Each input must land in exactly one cluster, and the two groups
    // should not be mixed.
    const firstFiveCluster = result.assignments
      .filter((a) => a.vectorIndex < 5)
      .map((a) => a.clusterId);
    const lastFiveCluster = result.assignments
      .filter((a) => a.vectorIndex >= 5)
      .map((a) => a.clusterId);
    // All members of the first group share a cluster id; same for the
    // second; and the two ids differ.
    expect(new Set(firstFiveCluster).size).toBe(1);
    expect(new Set(lastFiveCluster).size).toBe(1);
    expect(firstFiveCluster[0]).not.toBe(lastFiveCluster[0]);
  });

  it("forces exactly numClusters clusters when numClusters is set", () => {
    // Same 10-vector layout as above, but force K=3.
    const vectors = [
      f32([1.0, 0.05, 0.0]),
      f32([0.98, 0.04, 0.01]),
      f32([1.02, 0.06, 0.0]),
      f32([1.0, 0.05, 0.02]),
      f32([0.99, 0.05, 0.0]),
      f32([0.05, 1.0, 0.0]),
      f32([0.04, 0.98, 0.01]),
      f32([0.06, 1.02, 0.0]),
      f32([0.05, 1.0, 0.02]),
      f32([0.05, 0.99, 0.0]),
    ];
    const result = clusterHierarchical({ vectors, numClusters: 3 });
    expect(result.numClusters).toBe(3);
    expect(distinctClusterIds(result.assignments).size).toBe(3);
    expect(result.assignments).toHaveLength(10);
    // Every cluster id must be in [0, 3).
    for (const a of result.assignments) {
      expect(a.clusterId).toBeGreaterThanOrEqual(0);
      expect(a.clusterId).toBeLessThan(3);
    }
  });

  it("completes 100 random vectors in <2 seconds (perf sanity)", () => {
    const N = 100;
    const D = 64;
    const vectors: Float32Array[] = [];
    // Seeded-ish randomness via incremental hash so the test is
    // deterministic across runs.
    let seed = 0xc0ffee;
    function nextRand(): number {
      seed = (seed * 1664525 + 1013904223) | 0;
      return ((seed >>> 0) / 0xffffffff) * 2 - 1;
    }
    for (let i = 0; i < N; i++) {
      const v = new Float32Array(D);
      for (let k = 0; k < D; k++) v[k] = nextRand();
      vectors.push(v);
    }
    const t0 = performance.now();
    const result = clusterHierarchical({ vectors, cutHeight: 0.8 });
    const elapsedMs = performance.now() - t0;
    expect(result.assignments).toHaveLength(N);
    expect(result.numClusters).toBeGreaterThan(0);
    expect(elapsedMs).toBeLessThan(2000);
  });

  it("rejects mixed-dimension inputs", () => {
    expect(() =>
      clusterHierarchical({
        vectors: [f32([1, 0, 0]), f32([1, 0])],
      }),
    ).toThrow(/does not match/);
  });

  it("rejects empty vectors (dim 0)", () => {
    expect(() =>
      clusterHierarchical({
        vectors: [f32([]), f32([])],
      }),
    ).toThrow(/dim must be ≥1/);
  });

  it("rejects non-Float32Array entries", () => {
    expect(() =>
      // Passing a plain number array is a common caller mistake.
      // Cast through unknown so the test compiles.
      clusterHierarchical({
        vectors: [f32([1, 0, 0]), [1, 0, 0] as unknown as Float32Array],
      }),
    ).toThrow(/not a Float32Array/);
  });

  it("rejects numClusters > vectors.length", () => {
    expect(() =>
      clusterHierarchical({
        vectors: [f32([1, 0, 0]), f32([0, 1, 0])],
        numClusters: 5,
      }),
    ).toThrow(/cannot exceed vectors.length/);
  });

  it("rejects negative cutHeight", () => {
    expect(() =>
      clusterHierarchical({
        vectors: [f32([1, 0, 0]), f32([0, 1, 0])],
        cutHeight: -0.1,
      }),
    ).toThrow(/non-negative/);
  });
});

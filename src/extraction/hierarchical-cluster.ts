/**
 * Hierarchical clustering wrapper — LCM v4.1 §6 Group E (procedures).
 *
 * Library: `ml-hclust@4.0.0` (mljs ecosystem). Picked for:
 *
 *   1. ESM-native (`type: "module"`, `exports: { ".": "./lib/index.js" }`).
 *      This plugin ships ESM only; CJS-only libs would need interop shims.
 *   2. MIT licensed (this plugin is MIT).
 *   3. Active maintenance — v4.0.0 published 2025-11-26 (mljs-bot, last
 *      release before this work). The mljs org has been releasing across
 *      the family steadily; not a dead project.
 *   4. Small footprint — ml-hclust itself is 48KB unpacked. Transitive
 *      deps (ml-matrix, heap, ml-distance-euclidean, ml-distance-matrix)
 *      add another ~1.2MB on disk, but esbuild tree-shakes aggressively
 *      and most of ml-matrix is unused (we only touch agnes + Cluster).
 *      Empirical bundle delta: see `npm run build` output.
 *   5. API fit:
 *        - `agnes(data, { method: "ward", isDistanceMatrix: true })`
 *          accepts a precomputed distance matrix, which is exactly what
 *          we need for cosine-distance Ward (the lib's built-in
 *          distanceFunction defaults to euclidean).
 *        - The returned `Cluster` exposes both `cut(height)` and
 *          `group(K)` so we can satisfy both "let the dendrogram decide"
 *          and "force K" use cases without reaching into internals.
 *        - `Cluster.indices()` returns the leaf indices for a sub-cluster,
 *          so building the assignments map is one tree-walk.
 *
 * Alternatives considered:
 *
 *   - `hierarchical-clustering-js` — does not exist on npm (404).
 *   - `density-clustering` — DBSCAN/OPTICS/k-means only, no hierarchical
 *     agglomerative; wrong algorithm family.
 *   - `clusterfck` — deprecated by npm.
 *   - `clustering-js` — abandoned beta from years ago, no hierarchical.
 *
 * Caveat about Ward + cosine on a precomputed matrix:
 *
 *   Strict Ward minimizes within-cluster variance and assumes squared
 *   Euclidean distances. Feeding a cosine-distance matrix to Ward (the
 *   standard Lance–Williams update used by ml-hclust) does NOT satisfy
 *   that assumption mathematically — but it's the same approximation
 *   scipy gives you with `linkage(method="ward", metric="cosine")`,
 *   and is the conventional choice for clustering text embeddings where
 *   cosine similarity is the meaningful metric. If empirical eval shows
 *   wonky merges, switching to `method: "average"` (UPGMA) is a safe
 *   fallback that has no Euclidean assumption.
 */

import { agnes, type Cluster } from "ml-hclust";

/**
 * One vector → one cluster id. Cluster ids are dense integers
 * `[0, numClusters)`; assignment order in the array matches input order.
 */
export interface ClusterAssignment {
  /** Index into the input vectors array. */
  vectorIndex: number;
  /** Cluster id this vector belongs to. */
  clusterId: number;
}

export interface ClusterResult {
  assignments: ClusterAssignment[];
  numClusters: number;
}

export interface ClusterOptions {
  /** Vectors to cluster. All must have same dim. */
  vectors: Float32Array[];
  /**
   * Cluster height threshold for dendrogram cut. Smaller → more clusters.
   * Tune empirically against eval data; default 0.5 is a starting guess.
   *
   * Heights are in cosine-distance units, so range is [0, 2]. A cut at
   * 0.5 corresponds to grouping vectors with cosine similarity ≳ 0.5
   * after Ward agglomeration.
   */
  cutHeight?: number;
  /**
   * Force a specific cluster count instead of cutting by height.
   * If provided, `cutHeight` is ignored.
   *
   * Must be ≥ 1 and ≤ vectors.length.
   */
  numClusters?: number;
}

const DEFAULT_CUT_HEIGHT = 0.5;

/**
 * Hierarchical-cluster the input vectors using Ward linkage + cosine
 * distance. Returns one cluster assignment per input vector.
 *
 * Empty input returns `{assignments: [], numClusters: 0}`.
 * Single vector returns `{assignments: [{vectorIndex: 0, clusterId: 0}], numClusters: 1}`.
 *
 * Caller validates min-cluster-size (Group E filters to clusters with ≥8 members).
 *
 * Algorithm notes:
 *
 *   1. Cosine distance matrix is computed in `O(N^2 D)` where D = vector
 *      dim. For N=2000, D=1024 that's ~4B mul-adds — a few hundred ms in
 *      JS. We pre-normalize each vector once to cut this in half.
 *   2. ml-hclust's agnes is `O(N^3)` with the naive nearest-merge loop.
 *      For N=2000 that's ~8B ops — comfortably within the "few seconds
 *      per cluster pass" budget the architecture allows. For N>>2000 a
 *      different library would be required.
 *   3. We feed `isDistanceMatrix: true` so ml-hclust skips its internal
 *      euclidean call and uses our cosine matrix directly.
 */
export function clusterHierarchical(opts: ClusterOptions): ClusterResult {
  const { vectors, cutHeight = DEFAULT_CUT_HEIGHT, numClusters } = opts;

  // === Validation ===
  if (!Array.isArray(vectors)) {
    throw new TypeError("[hierarchical-cluster] vectors must be an array");
  }
  if (vectors.length === 0) {
    return { assignments: [], numClusters: 0 };
  }

  const dim = vectors[0].length;
  if (dim < 1) {
    throw new RangeError(
      `[hierarchical-cluster] vector dim must be ≥1 (got ${dim})`,
    );
  }
  for (let i = 0; i < vectors.length; i++) {
    if (!(vectors[i] instanceof Float32Array)) {
      throw new TypeError(
        `[hierarchical-cluster] vectors[${i}] is not a Float32Array`,
      );
    }
    if (vectors[i].length !== dim) {
      throw new RangeError(
        `[hierarchical-cluster] vectors[${i}].length=${vectors[i].length} ` +
          `does not match vectors[0].length=${dim}`,
      );
    }
  }

  // === Single-vector shortcut ===
  // ml-hclust's agnes requires N ≥ 2 (it runs N-1 merge iterations).
  if (vectors.length === 1) {
    return {
      assignments: [{ vectorIndex: 0, clusterId: 0 }],
      numClusters: 1,
    };
  }

  // === Validate numClusters if provided ===
  if (numClusters !== undefined) {
    if (!Number.isInteger(numClusters) || numClusters < 1) {
      throw new RangeError(
        `[hierarchical-cluster] numClusters must be a positive integer (got ${numClusters})`,
      );
    }
    if (numClusters > vectors.length) {
      throw new RangeError(
        `[hierarchical-cluster] numClusters=${numClusters} ` +
          `cannot exceed vectors.length=${vectors.length}`,
      );
    }
  }

  // === Build cosine-distance matrix ===
  // Pre-normalize each vector once. Cosine distance = 1 - dot(a_norm, b_norm).
  const norms = vectors.map(normalizeCopy);
  const N = norms.length;
  const distMatrix: number[][] = new Array(N);
  for (let i = 0; i < N; i++) {
    distMatrix[i] = new Array(N);
    distMatrix[i][i] = 0;
  }
  for (let i = 0; i < N; i++) {
    const ni = norms[i];
    for (let j = i + 1; j < N; j++) {
      const nj = norms[j];
      let dot = 0;
      for (let k = 0; k < dim; k++) {
        dot += ni[k] * nj[k];
      }
      // Clamp into [-1, 1] to absorb floating-point drift, then convert
      // to cosine distance ∈ [0, 2]. Negative-distance values would
      // confuse ml-hclust's smallest-distance scan.
      const cosSim = dot < -1 ? -1 : dot > 1 ? 1 : dot;
      const d = 1 - cosSim;
      distMatrix[i][j] = d;
      distMatrix[j][i] = d;
    }
  }

  // === Run agnes (Ward linkage on precomputed distance) ===
  const tree = agnes(distMatrix, {
    method: "ward",
    isDistanceMatrix: true,
  });

  // === Cut the tree ===
  let groups: Cluster[];
  if (numClusters !== undefined) {
    // `Cluster.group(K)` returns a synthetic root whose children are
    // exactly K sub-clusters.
    const grouped = tree.group(numClusters);
    groups = grouped.children;
  } else {
    // `Cluster.cut(h)` returns sub-clusters whose internal max-height
    // is ≤ h. With a cosine-distance matrix, h is in cosine-distance
    // units (range [0, 2]).
    if (typeof cutHeight !== "number" || !Number.isFinite(cutHeight) || cutHeight < 0) {
      throw new RangeError(
        `[hierarchical-cluster] cutHeight must be a non-negative finite number (got ${cutHeight})`,
      );
    }
    groups = tree.cut(cutHeight);
  }

  // === Build assignments ===
  // Walk each group, collect leaf indices, assign a cluster id per group.
  // Cluster ids are dense [0, groups.length).
  const assignments: ClusterAssignment[] = new Array(N);
  for (let cid = 0; cid < groups.length; cid++) {
    const leafIndices = groups[cid].indices();
    for (const vectorIndex of leafIndices) {
      assignments[vectorIndex] = { vectorIndex, clusterId: cid };
    }
  }

  // Sanity check — every input vector must be covered exactly once.
  // This protects against future bugs in ml-hclust where a leaf could
  // be skipped.
  for (let i = 0; i < N; i++) {
    if (assignments[i] === undefined) {
      throw new Error(
        `[hierarchical-cluster] internal error: vector index ${i} was not assigned to any cluster ` +
          `(N=${N}, groups=${groups.length}); ml-hclust API contract may have changed`,
      );
    }
  }

  return { assignments, numClusters: groups.length };
}

/**
 * Return a unit-length copy of `v`. Caller passes Float32Array but we
 * promote to Float64Array internally because the distance-matrix loop is
 * the hottest spot and Float64 multiplication is at least as fast as
 * Float32 on modern V8 — and avoids accumulating Float32 rounding error
 * over a 1024-dim dot product.
 *
 * Zero-vector input is returned as-is (any normalization would produce
 * NaN); the resulting cosine distance against any other vector will be
 * 1, which is the most-distant value Ward will see and effectively
 * isolates the zero vector into its own cluster — a reasonable
 * degenerate-case behavior.
 */
function normalizeCopy(v: Float32Array): Float64Array {
  const out = new Float64Array(v.length);
  let mag = 0;
  for (let i = 0; i < v.length; i++) {
    mag += v[i] * v[i];
  }
  if (mag === 0) {
    // Leave as zeros; cosine distance vs any other vector is then 1
    // (since 1 - dot(0, x) = 1 - 0 = 1).
    return out;
  }
  const inv = 1 / Math.sqrt(mag);
  for (let i = 0; i < v.length; i++) {
    out[i] = v[i] * inv;
  }
  return out;
}

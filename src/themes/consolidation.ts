/**
 * Themes idle consolidation — LCM v4.1 §6.3 / Group G.
 *
 * OPTIONAL feature — themes are agent-explicit only, NEVER in the
 * assemble() pyramid (per RAG-leak adversarial finding in v4 review).
 * Caller invokes themes by:
 *
 *   - lcm_recent_themes (agent tool, deferred): list themes for a session
 *   - lcm_theme_explain (agent tool, deferred): expand a theme's sources
 *   - lcm_search_themes (agent tool, deferred): semantic theme search
 *
 * This module owns ONLY the consolidation pass:
 *   1. Caller supplies a session_key + a list of candidate leaves
 *      (with embeddings); orchestrator decides cadence (idle pass)
 *   2. Pre-condition: caller verifies embedding coverage ≥95% on the
 *      session — themes from a partially-embedded corpus are biased.
 *      We don't enforce that here; that's a /lcm worker / /lcm health
 *      gate.
 *   3. Cluster via E.spike's clusterHierarchical wrapper (Ward + cosine).
 *   4. For each cluster ≥ minOccurrences (default 5; lower than
 *      procedure-mining's 8 because themes are softer / more
 *      tolerant of small clusters):
 *        a. Call INJECTED `nameTheme(cluster) → {name, description}`
 *        b. Insert lcm_themes row + lcm_theme_sources rows
 *
 * Status semantics (per v4.1.1):
 *   - 'active': just-consolidated, agent-queryable
 *   - 'stale': source leaves changed (suppression trigger flips this);
 *     re-consolidation needed before serving
 *   - 'archived': operator-marked; not visible to agents
 *
 * Suppression cascade (lives in migration trigger):
 *   AFTER UPDATE OF suppressed_at ON summaries WHEN suppressed_at not NULL
 *   → flip status='active' → 'stale' for any theme that referenced it
 *
 * Hard-delete cascade (FK ON DELETE CASCADE on lcm_theme_sources):
 *   DELETE summary → drop the source row; theme keeps its row but
 *   source_leaf_count goes stale.
 */

import type { DatabaseSync } from "node:sqlite";
import { clusterHierarchical } from "../extraction/hierarchical-cluster.js";

export interface CandidateLeafForTheme {
  summaryId: string;
  vector: Float32Array;
  /** For optional context to the naming pass. */
  contentExcerpt?: string;
}

export interface NameThemeArgs {
  /** Leaves in this cluster (in input order). */
  leaves: CandidateLeafForTheme[];
}

export interface NameThemeResult {
  /** Short label for the theme (≤80 chars recommended). */
  name: string;
  /** 1-3 sentence description. */
  description: string;
  /** Optional confidence 0..1 — caller may use to gate writes. */
  confidence?: number;
  /**
   * Optional model identifier — recorded on the theme row for audit.
   * If not provided, defaults to 'mock' (test) / caller wires real model.
   */
  modelUsed?: string;
}

export type NameThemeFn = (args: NameThemeArgs) => Promise<NameThemeResult>;

export interface ConsolidateThemesOptions {
  sessionKey: string;
  passId: string;
  /** Min cluster size to consolidate. Default 5 (themes are softer than
   *  procedures, which require 8). */
  minOccurrences?: number;
  /** Override hierarchical-cluster cutHeight. Default 0.5. */
  cutHeight?: number;
  /** Skip clusters with naming-pass confidence below this. Default 0.6. */
  minConfidence?: number;
}

export interface ConsolidateThemesReport {
  sessionKey: string;
  candidateCount: number;
  clusterCount: number;
  largeClusterCount: number;
  themesWritten: number;
  namingRejected: number;
  themes: Array<{
    themeId: string;
    name: string;
    sourceLeafCount: number;
    confidence?: number;
  }>;
}

const DEFAULT_MIN_OCCURRENCES = 5;
const DEFAULT_MIN_CONFIDENCE = 0.6;

/**
 * Run a themes-consolidation pass over the supplied candidate leaves.
 *
 * Pure: caller pre-fetches candidates + their embeddings; this module
 * clusters + names + persists. No DB queries to fetch candidates here
 * (operator decides scope: last-week-leaves, all-active-leaves, etc.).
 */
export async function consolidateThemesPass(
  db: DatabaseSync,
  candidates: CandidateLeafForTheme[],
  nameTheme: NameThemeFn,
  opts: ConsolidateThemesOptions,
): Promise<ConsolidateThemesReport> {
  const minOcc = opts.minOccurrences ?? DEFAULT_MIN_OCCURRENCES;
  const minConf = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;

  const report: ConsolidateThemesReport = {
    sessionKey: opts.sessionKey,
    candidateCount: candidates.length,
    clusterCount: 0,
    largeClusterCount: 0,
    themesWritten: 0,
    namingRejected: 0,
    themes: [],
  };

  // Dedupe by summaryId (defense)
  const seen = new Set<string>();
  const unique = candidates.filter((c) => {
    if (seen.has(c.summaryId)) return false;
    seen.add(c.summaryId);
    return true;
  });
  if (unique.length < minOcc) return report;

  // Cluster
  const cr = clusterHierarchical({
    vectors: unique.map((c) => c.vector),
    cutHeight: opts.cutHeight ?? 0.5,
  });
  report.clusterCount = cr.numClusters;

  // Group by cluster
  const byCluster = new Map<number, CandidateLeafForTheme[]>();
  for (const a of cr.assignments) {
    const list = byCluster.get(a.clusterId) ?? [];
    list.push(unique[a.vectorIndex]);
    byCluster.set(a.clusterId, list);
  }

  const orderedClusters = [...byCluster.entries()]
    .map(([clusterId, leaves]) => ({ clusterId, leaves }))
    .sort((a, b) => b.leaves.length - a.leaves.length);

  for (const { clusterId, leaves } of orderedClusters) {
    if (leaves.length < minOcc) continue;
    report.largeClusterCount++;

    let result: NameThemeResult;
    try {
      result = await nameTheme({ leaves });
    } catch (e: unknown) {
      // Naming pass crashed for this cluster — record + skip
      report.namingRejected++;
      report.themes.push({
        themeId: "(naming-error)",
        name: `(failed: ${e instanceof Error ? e.message : String(e)})`,
        sourceLeafCount: leaves.length,
      });
      continue;
    }

    if (typeof result.confidence === "number" && result.confidence < minConf) {
      report.namingRejected++;
      continue;
    }
    if (!result.name || result.name.trim().length === 0) {
      report.namingRejected++;
      continue;
    }

    const themeId = `theme_${opts.sessionKey.replace(/[^a-z0-9]/gi, "_").slice(0, 30)}_${randomSuffix()}`;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        `INSERT INTO lcm_themes
           (theme_id, session_key, name, description, source_leaf_count,
            consolidation_model, consolidation_pass_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        themeId,
        opts.sessionKey,
        result.name.trim(),
        result.description?.trim() ?? "",
        leaves.length,
        result.modelUsed ?? "mock",
        opts.passId,
      );
      const linkInsert = db.prepare(
        `INSERT INTO lcm_theme_sources (theme_id, summary_id) VALUES (?, ?)`,
      );
      for (const leaf of leaves) {
        linkInsert.run(themeId, leaf.summaryId);
      }
      db.exec("COMMIT");
      report.themesWritten++;
      report.themes.push({
        themeId,
        name: result.name.trim(),
        sourceLeafCount: leaves.length,
        confidence: result.confidence,
      });
    } catch (e) {
      db.exec("ROLLBACK");
      report.namingRejected++;
    }
  }

  return report;
}

/**
 * Mark all 'active' themes referencing the given leaf as 'stale'.
 * Used by the suppression-cascade trigger AND by manual operator
 * actions. Returns count of themes marked stale.
 *
 * Note: the migration trigger does this automatically on suppression;
 * this function is exposed for /lcm purge call sites that want
 * synchronous staleness without waiting for the trigger.
 */
export function markThemesStaleFor(
  db: DatabaseSync,
  summaryId: string,
): number {
  const r = db
    .prepare(
      `UPDATE lcm_themes SET status = 'stale'
         WHERE status = 'active' AND theme_id IN (
           SELECT DISTINCT theme_id FROM lcm_theme_sources
             WHERE summary_id = ?
         )`,
    )
    .run(summaryId);
  return Number(r.changes);
}

/**
 * List themes for a session. Status filter: 'active' (default),
 * 'stale', 'archived', or 'all'.
 */
export interface ListThemesArgs {
  sessionKey: string;
  status?: "active" | "stale" | "archived" | "all";
  limit?: number;
}

export interface ThemeRecord {
  themeId: string;
  name: string;
  description: string;
  sourceLeafCount: number;
  consolidatedAt: string;
  status: "active" | "stale" | "archived";
}

export function listThemes(db: DatabaseSync, args: ListThemesArgs): ThemeRecord[] {
  const status = args.status ?? "active";
  const limit = args.limit ?? 50;
  let sql = `SELECT theme_id, name, description, source_leaf_count, consolidated_at, status
               FROM lcm_themes WHERE session_key = ?`;
  const params: unknown[] = [args.sessionKey];
  if (status !== "all") {
    sql += " AND status = ?";
    params.push(status);
  }
  sql += " ORDER BY consolidated_at DESC LIMIT ?";
  params.push(limit);
  const rows = db.prepare(sql).all(...params) as Array<{
    theme_id: string;
    name: string;
    description: string;
    source_leaf_count: number;
    consolidated_at: string;
    status: "active" | "stale" | "archived";
  }>;
  return rows.map((r) => ({
    themeId: r.theme_id,
    name: r.name,
    description: r.description,
    sourceLeafCount: r.source_leaf_count,
    consolidatedAt: r.consolidated_at,
    status: r.status,
  }));
}

function randomSuffix(): string {
  return Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, "0");
}

/**
 * Procedure mining pass — LCM v4.1 §6.2 Group E.
 *
 * Worker job that mines procedures from the corpus:
 *
 *   1. Pull candidate leaves (passed through procedure-prefilter, have
 *      embeddings).
 *   2. Cluster their embeddings via ml-hclust (E.spike's wrapper).
 *   3. For each cluster with ≥minOccurrences members (default 8),
 *      call the LLM judge to confirm + name + extract steps.
 *   4. Judge confidence > minConfidence (default 0.9) → write to
 *      lcm_procedures with status='active'.
 *
 * Pure DB writes for the active row(s); LLM calls injected as
 * `judgeProcedureCluster` callback (caller wires production LLM,
 * tests inject deterministic mock).
 *
 * NOT implemented here: incremental mining (re-clustering only the
 * delta since last pass). For now this is a full-corpus pass; the
 * worker scheduler decides cadence (default once per day per session).
 */

import type { DatabaseSync } from "node:sqlite";
import { clusterHierarchical } from "./hierarchical-cluster.js";
import { prefilterContent } from "./procedure-prefilter.js";

export interface CandidateLeaf {
  summaryId: string;
  sessionKey: string;
  content: string;
  /** Embedding for clustering. Caller pre-fetched from vec0. */
  vector: Float32Array;
}

export interface ClusterCandidate {
  /** Leaves in this cluster, ordered by score (highest first). */
  leaves: CandidateLeaf[];
  /** Cluster id from ml-hclust (informational). */
  clusterId: number;
}

export interface JudgeProcedureArgs {
  cluster: ClusterCandidate;
}

export interface JudgeProcedureResult {
  /** Did the judge confirm this cluster represents a real procedure? */
  confirmed: boolean;
  /** Confidence score 0..1. Caller filters on minConfidence. */
  confidence: number;
  /** Procedure name (only set if confirmed). */
  procedureName?: string;
  /** Procedure steps (free-text or JSON-stringified array). */
  steps?: string;
  /** Brief reason for the verdict (logged in extracted_by_pass_id field). */
  reason?: string;
}

export type JudgeProcedureCluster = (args: JudgeProcedureArgs) => Promise<JudgeProcedureResult>;

export interface MineProceduresOptions {
  sessionKey: string;
  /**
   * Min cluster size to consider. Per architecture-v4.1: 8+ occurrences.
   */
  minOccurrences?: number;
  /**
   * Min judge confidence to write status='active'. Default 0.9.
   * Lower-confidence clusters get status='draft' instead (operator reviews).
   */
  minConfidence?: number;
  /**
   * Override hierarchical-cluster cutHeight. Default 0.5 (per
   * E.spike default).
   */
  cutHeight?: number;
  /**
   * Identifier for this mining pass (e.g. timestamp + worker_id). Recorded
   * in lcm_procedures.extracted_by_pass_id for traceability.
   */
  passId: string;
}

export interface MineProceduresReport {
  sessionKey: string;
  /** Total candidates considered (post-prefilter, with embeddings). */
  candidateCount: number;
  /** Number of clusters formed. */
  clusterCount: number;
  /** Clusters that met minOccurrences threshold. */
  largeClusterCount: number;
  /** Clusters where judge confirmed AND confidence ≥ minConfidence. */
  activeProceduresWritten: number;
  /** Clusters where judge confirmed BUT confidence < minConfidence. */
  draftProceduresWritten: number;
  /** Clusters where judge declined. */
  judgeRejected: number;
  /** Per-cluster details for diagnostics. */
  clusters: Array<{
    clusterId: number;
    size: number;
    judged: boolean;
    confirmed: boolean;
    confidence?: number;
    procedureId?: string;
    skipReason?: string;
  }>;
}

const DEFAULT_MIN_OCCURRENCES = 8;
const DEFAULT_MIN_CONFIDENCE = 0.9;

/**
 * Run a procedure-mining pass over the given candidate leaves.
 * Caller pre-fetches the candidates (filtered + embedded). This module
 * just clusters + judges + writes.
 *
 * Returns a report with per-cluster details for telemetry.
 *
 * Each judge call runs in sequence (NOT parallel) so a single failed
 * judge call can be retried without spinning up duplicates. Clusters
 * are processed largest-first.
 */
export async function mineProceduresPass(
  db: DatabaseSync,
  candidates: CandidateLeaf[],
  judge: JudgeProcedureCluster,
  opts: MineProceduresOptions,
): Promise<MineProceduresReport> {
  const minOcc = opts.minOccurrences ?? DEFAULT_MIN_OCCURRENCES;
  const minConf = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;

  const report: MineProceduresReport = {
    sessionKey: opts.sessionKey,
    candidateCount: candidates.length,
    clusterCount: 0,
    largeClusterCount: 0,
    activeProceduresWritten: 0,
    draftProceduresWritten: 0,
    judgeRejected: 0,
    clusters: [],
  };

  // 0. Filter candidates by prefilter signals (defense-in-depth — caller
  //    should have pre-filtered, but guard anyway). Also dedupe by
  //    summaryId to handle a caller that passed dups.
  const seenIds = new Set<string>();
  const uniqueCandidates = candidates.filter((c) => {
    if (seenIds.has(c.summaryId)) return false;
    seenIds.add(c.summaryId);
    return prefilterContent(c.content).isCandidate;
  });

  if (uniqueCandidates.length < minOcc) {
    // Not enough candidates to form even one valid cluster
    return report;
  }

  // 1. Cluster the embedding vectors
  const clusterResult = clusterHierarchical({
    vectors: uniqueCandidates.map((c) => c.vector),
    cutHeight: opts.cutHeight ?? 0.5,
  });
  report.clusterCount = clusterResult.numClusters;

  // 2. Group candidates by cluster id
  const byCluster = new Map<number, CandidateLeaf[]>();
  for (const assignment of clusterResult.assignments) {
    const leaf = uniqueCandidates[assignment.vectorIndex];
    const list = byCluster.get(assignment.clusterId) ?? [];
    list.push(leaf);
    byCluster.set(assignment.clusterId, list);
  }

  // 3. Sort clusters by size desc; process largest first.
  const orderedClusters: ClusterCandidate[] = [...byCluster.entries()]
    .map(([clusterId, leaves]) => ({ clusterId, leaves }))
    .sort((a, b) => b.leaves.length - a.leaves.length);

  // 4. Judge + write each cluster that meets minOccurrences
  for (const cluster of orderedClusters) {
    const size = cluster.leaves.length;
    const detail: MineProceduresReport["clusters"][number] = {
      clusterId: cluster.clusterId,
      size,
      judged: false,
      confirmed: false,
    };
    if (size < minOcc) {
      detail.skipReason = `below-min-occurrences (size=${size} < min=${minOcc})`;
      report.clusters.push(detail);
      continue;
    }
    report.largeClusterCount++;

    let judgement: JudgeProcedureResult;
    try {
      judgement = await judge({ cluster });
      detail.judged = true;
    } catch (e: unknown) {
      detail.skipReason = `judge-error: ${e instanceof Error ? e.message : String(e)}`;
      report.clusters.push(detail);
      continue;
    }

    detail.confirmed = judgement.confirmed;
    detail.confidence = judgement.confidence;

    if (!judgement.confirmed) {
      report.judgeRejected++;
      detail.skipReason = `judge-declined: ${judgement.reason ?? "no reason"}`;
      report.clusters.push(detail);
      continue;
    }

    const status: "active" | "draft" =
      judgement.confidence >= minConf ? "active" : "draft";
    if (status === "active") report.activeProceduresWritten++;
    else report.draftProceduresWritten++;

    const procedureId = `proc_${opts.sessionKey.replace(/[^a-z0-9]/gi, "_").slice(0, 30)}_${randomSuffix()}`;
    const sourceLeafIds = JSON.stringify(cluster.leaves.map((l) => l.summaryId));
    const lastSeenAt = new Date().toISOString();
    db.prepare(
      `INSERT INTO lcm_procedures
         (procedure_id, session_key, name, steps, last_seen_at, source_leaf_ids,
          status, occurrence_count, confidence, extracted_by_pass_id, extraction_source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'auto')`,
    ).run(
      procedureId,
      opts.sessionKey,
      judgement.procedureName ?? "(unnamed procedure)",
      judgement.steps ?? "",
      lastSeenAt,
      sourceLeafIds,
      status,
      cluster.leaves.length,
      judgement.confidence,
      opts.passId,
    );
    detail.procedureId = procedureId;
    report.clusters.push(detail);
  }

  return report;
}

function randomSuffix(): string {
  return Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, "0");
}

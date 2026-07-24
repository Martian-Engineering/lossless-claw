/**
 * Managed session-file rotation: startup/runtime auto-rotation of oversized
 * session JSONL files and the rotate-session-storage operation family
 * (transcript rewrite, raw-context compaction outside the fresh tail, and
 * optional database backup).
 *
 * The service runs against a narrow RotationHost view of the engine; the
 * host interface documents exactly which engine facilities rotation needs.
 *
 * Extracted from engine.ts (Phase 3 of the engine decomposition).
 */
import { stat, writeFile } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { describeLogError } from "./lcm-log.js";
import type { AgentMessage } from "./openclaw-bridge.js";
import { createLcmDatabaseBackup } from "./plugin/lcm-db-backup.js";
import { LcmSummarySpendLimitError } from "./summarize.js";
import {
  DatabaseTransactionTimeoutError,
  withExclusiveDatabaseLock,
} from "./transaction-mutex.js";
import { readLeafPathRawEntries, type TranscriptRawEntry } from "./transcript.js";
import { asRecord, isMissingFileError, normalizeSessionFilePathForComparison } from "./value-utils.js";
import type { CompactionEngine } from "./compaction.js";
import type { CompactionGuards } from "./compaction-guards.js";
import type { LcmConfig } from "./db/config.js";
import type { ContextEngineInfo } from "./openclaw-bridge.js";
import type { TranscriptReconcileResult } from "./reconcile-plan.js";
import type { CompactionTelemetryStore } from "./store/compaction-telemetry-store.js";
import type { ConversationRecord, ConversationStore } from "./store/conversation-store.js";
import type { SummaryStore } from "./store/summary-store.js";
import type { LcmSummarizeFn } from "./summarize.js";
import type { LcmDependencies, StartupSessionFileCandidate } from "./types.js";

export type TranscriptRewriteReplacement = {
  entryId: string;
  message: AgentMessage;
};

export type TranscriptRewriteRequest = {
  replacements: TranscriptRewriteReplacement[];
};

export type ContextEngineMaintenanceResult = {
  changed: boolean;
  bytesFreed: number;
  rewrittenEntries: number;
  reason?: string;
};

type RotateTranscriptRewriteResult = {
  checkpointSize: number;
  bytesRemoved: number;
  preservedTailMessageCount: number;
};

type AutoRotateSessionFilePhase = "startup" | "runtime";
type AutoRotateSessionFileAction = "rotate" | "warn" | "skip" | "summary";
type AutoRotateSessionFileCaller = "after-turn" | "maintain";

export type RotateSessionStorageResult =
  | {
      kind: "rotated";
      conversationId: number;
      preservedTailMessageCount: number;
      checkpointSize: number;
      bytesRemoved: number;
    }
  | {
      kind: "unavailable";
      reason: string;
    };

export type RotateSessionStorageWithBackupResult =
  | {
      kind: "rotated";
      currentConversationId: number;
      currentMessageCount: number;
      backupPath: string;
      preservedTailMessageCount: number;
      checkpointSize: number;
      bytesRemoved: number;
    }
  | {
      kind: "backup_failed";
      currentConversationId: number;
      currentMessageCount: number;
      reason: string;
    }
  | {
      kind: "rotate_failed";
      currentConversationId: number;
      currentMessageCount: number;
      backupPath: string;
      reason: string;
    }
  | {
      kind: "unavailable";
      reason: string;
      currentConversationId?: number;
      currentMessageCount?: number;
      backupPath?: string;
    };

type StartupAutoRotateCandidate = {
  sessionId: string;
  sessionKey: string;
  sessionFile: string;
  conversationId: number;
  sizeBytes: number;
  currentMessageCount: number;
};

type StartupAutoRotateBatchResult = {
  rotated: number;
  warned: number;
  bytesRemoved: number;
  backupPath?: string;
  backupCreated: number;
};

const AUTO_ROTATE_DATABASE_LOCK_TIMEOUT_MS = 30_000;

function isRotatePreservedEntryType(type: string): boolean {
  return (
    type === "message" ||
    type === "model_change" ||
    type === "thinking_level_change" ||
    type === "session_info"
  );
}

function normalizeRotateTailMessageCount(value: number, branchMessageCount: number): number {
  if (branchMessageCount <= 0) {
    return 0;
  }
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.max(1, Math.min(branchMessageCount, Math.floor(value)));
}

/**
 * The slice of LcmContextEngine that session rotation depends on. Wider than
 * a leaf service on purpose: rotation orchestrates reconciliation, compaction
 * and summarizer resolution, and this interface is the explicit inventory of
 * that coupling.
 */
export type RotationHost = {
  readonly config: LcmConfig;
  readonly db: DatabaseSync;
  readonly deps: LcmDependencies;
  readonly info: ContextEngineInfo;
  readonly conversationStore: ConversationStore;
  readonly summaryStore: SummaryStore;
  readonly compaction: CompactionEngine;
  readonly compactionGuards: CompactionGuards;
  readonly compactionTelemetryStore: CompactionTelemetryStore;
  ensureMigrated(): void;
  shouldIgnoreSession(params: { sessionId?: string; sessionKey?: string }): boolean;
  isStatelessSession(sessionKey: string | undefined): boolean;
  resolveSessionQueueKey(sessionId?: string, sessionKey?: string): string;
  withSessionQueue<T>(
    queueKey: string,
    operation: () => Promise<T>,
    options?: { operationName?: string; context?: string },
  ): Promise<T>;
  resolveSummarize(params: {
    legacyParams?: Record<string, unknown>;
    customInstructions?: string;
    breakerScope: string;
  }): Promise<{ summarize: LcmSummarizeFn; summaryModel: string; breakerKey?: string }>;
  buildSummarizerLegacyParams(params: {
    legacyParams?: Record<string, unknown>;
    sessionKey?: string;
  }): Record<string, unknown> | undefined;
  applyAssemblyBudgetCap(budget: number): number;
  refreshBootstrapState(params: {
    conversationId: number;
    sessionFile: string;
    fileStats?: { size: number; mtimeMs: number };
    lastProcessedEntryHash?: string | null;
    forkBounded?: boolean;
    forkSourceMessageCount?: number;
  }): Promise<void>;
  reconcileTranscriptTailForAfterTurn(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    isHeartbeat?: boolean;
    allowNoAnchorImportOnCheckpointMissing?: boolean;
  }): Promise<TranscriptReconcileResult>;
  reconcileTranscriptTailForAfterTurnInSessionQueue(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    isHeartbeat?: boolean;
    allowNoAnchorImportOnCheckpointMissing?: boolean;
  }): Promise<TranscriptReconcileResult>;
};

export class SessionRotationService {
  private oversizedAutoRotateCheckpointByQueueKey = new Map<string, number>();

  /**
   * Create the "rotate" database backup, classifying failure as thrown
   * (backup-failed) vs null result (backup-unavailable). Callers map the
   * outcome onto their own reporting (startup decision log vs typed result).
   */
  private createRotateDatabaseBackup():
    | { outcome: "created"; backupPath: string }
    | { outcome: "backup-failed"; error: unknown }
    | { outcome: "backup-unavailable" } {
    let backupPath: string | null;
    try {
      backupPath = createLcmDatabaseBackup(this.host.db, {
        databasePath: this.host.config.databasePath,
        label: "rotate",
        replaceLatest: true,
      });
    } catch (error) {
      return { outcome: "backup-failed", error };
    }
    if (!backupPath) {
      return { outcome: "backup-unavailable" };
    }
    return { outcome: "created", backupPath };
  }

  constructor(private readonly host: RotationHost) {}

  /** Return the configured auto-rotation mode for the current phase. */
  private getAutoRotateSessionFileMode(
    phase: AutoRotateSessionFilePhase,
  ): "rotate" | "warn" | "off" {
    return phase === "startup"
      ? this.host.config.autoRotateSessionFiles.startup
      : this.host.config.autoRotateSessionFiles.runtime;
  }

  /** Emit one structured, grep-friendly auto-rotation log line. */
  logAutoRotateSessionFileDecision(params: {
    level?: "info" | "warn" | "error";
    phase: AutoRotateSessionFilePhase;
    action: AutoRotateSessionFileAction;
    sessionId?: string;
    sessionKey?: string;
    conversationId?: number;
    sessionFile?: string;
    sizeBytes?: number;
    thresholdBytes?: number;
    durationMs: number;
    backupPath?: string;
    bytesRemoved?: number;
    preservedTailMessageCount?: number;
    checkpointSize?: number;
    currentMessageCount?: number;
    scanned?: number;
    eligible?: number;
    rotated?: number;
    warned?: number;
    skipped?: number;
    backupCreated?: number;
    reason?: string;
    error?: string;
  }): void {
    const fields: Array<[string, string | number | undefined]> = [
      ["phase", params.phase],
      ["action", params.action],
      ["sessionId", params.sessionId],
      ["sessionKey", params.sessionKey],
      ["conversationId", params.conversationId],
      ["sessionFile", params.sessionFile],
      ["sizeBytes", params.sizeBytes],
      ["thresholdBytes", params.thresholdBytes],
      ["durationMs", params.durationMs],
      ["backupPath", params.backupPath],
      ["bytesRemoved", params.bytesRemoved],
      ["preservedTailMessageCount", params.preservedTailMessageCount],
      ["checkpointSize", params.checkpointSize],
      ["currentMessageCount", params.currentMessageCount],
      ["scanned", params.scanned],
      ["eligible", params.eligible],
      ["rotated", params.rotated],
      ["warned", params.warned],
      ["skipped", params.skipped],
      ["backupCreated", params.backupCreated],
      ["reason", params.reason],
      ["error", params.error],
    ];
    const rendered = fields
      .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
      .map(([key, value]) => `${key}=${String(value).replace(/\s+/g, "_")}`)
      .join(" ");
    const level = params.level ?? "info";
    this.host.deps.log[level](`[lcm] auto-rotate: ${rendered}`);
  }

  /** Check one LCM-managed transcript and rotate it when policy allows. */
  async maybeAutoRotateManagedSessionFile(params: {
    phase: AutoRotateSessionFilePhase;
    caller?: AutoRotateSessionFileCaller;
    sessionId?: string;
    sessionKey?: string;
    sessionFile?: string;
    conversationId?: number;
    allowSessionFileRewrite?: boolean;
    rewriteDeferralReason?: string;
  }): Promise<void> {
    const startedAt = Date.now();
    const thresholdBytes = this.host.config.autoRotateSessionFiles.sizeBytes;
    const sessionId = params.sessionId?.trim();
    const sessionKey = params.sessionKey?.trim();
    const sessionFile = params.sessionFile?.trim();
    const baseLog = {
      phase: params.phase,
      sessionId,
      sessionKey,
      conversationId: params.conversationId,
      sessionFile,
      thresholdBytes,
    };

    const skip = (reason: string, sizeBytes?: number): void => {
      this.logAutoRotateSessionFileDecision({
        ...baseLog,
        action: "skip",
        sizeBytes,
        durationMs: Date.now() - startedAt,
        reason,
      });
    };

    // Cheap guards first: these must not stat or mutate transcripts for
    // sessions that LCM does not actively and durably own.
    if (!this.host.config.autoRotateSessionFiles.enabled) {
      skip("disabled");
      return;
    }
    const mode = this.getAutoRotateSessionFileMode(params.phase);
    if (mode === "off") {
      skip("mode-off");
      return;
    }
    if (!this.host.info.ownsCompaction) {
      skip("engine-unhealthy");
      return;
    }
    if (!sessionId || !sessionKey) {
      skip("missing-session-identity");
      return;
    }
    if (!sessionFile) {
      skip("missing-session-file");
      return;
    }
    if (this.host.shouldIgnoreSession({ sessionId, sessionKey })) {
      skip("session-excluded");
      return;
    }
    if (this.host.isStatelessSession(sessionKey)) {
      skip("stateless-session");
      return;
    }

    // The file stat is the only runtime hot-path filesystem work before we
    // know a rotation is needed.
    let sizeBytes: number;
    try {
      sizeBytes = (await stat(sessionFile)).size;
    } catch (error) {
      this.logAutoRotateSessionFileDecision({
        ...baseLog,
        action: "warn",
        durationMs: Date.now() - startedAt,
        reason: "session-file-stat-failed",
        error: describeLogError(error),
        level: "warn",
      });
      return;
    }

    if (sizeBytes <= thresholdBytes) {
      this.oversizedAutoRotateCheckpointByQueueKey.delete(
        this.host.resolveSessionQueueKey(sessionId, sessionKey),
      );
      skip("below-threshold", sizeBytes);
      return;
    }

    // Reconfirm active LCM ownership after the size check. Startup scans pass a
    // conversation id; runtime checks resolve the current session identity.
    let conversation: ConversationRecord | null;
    try {
      conversation = params.conversationId !== undefined
        ? await this.host.conversationStore.getConversation(params.conversationId)
        : await this.host.conversationStore.getConversationForSession({ sessionId, sessionKey });
    } catch (error) {
      this.logAutoRotateSessionFileDecision({
        ...baseLog,
        action: "warn",
        sizeBytes,
        durationMs: Date.now() - startedAt,
        reason: "conversation-lookup-failed",
        error: describeLogError(error),
        level: "warn",
      });
      return;
    }
    if (!conversation?.active) {
      skip("no-active-conversation", sizeBytes);
      return;
    }

    // If one rotate could not shrink below the threshold, wait for at least one
    // threshold worth of new growth before trying again. This avoids a turn-by-
    // turn loop when the preserved tail is itself larger than the configured cap.
    const queueKey = this.host.resolveSessionQueueKey(sessionId, sessionKey);
    const previousOversizedCheckpoint = this.oversizedAutoRotateCheckpointByQueueKey.get(queueKey);
    if (
      previousOversizedCheckpoint !== undefined &&
      sizeBytes < previousOversizedCheckpoint + thresholdBytes
    ) {
      skip("previous-rotate-left-file-over-threshold", sizeBytes);
      return;
    }

    // Warn mode is operational telemetry only: it proves the policy would have
    // fired without touching the live transcript.
    if (mode === "warn") {
      this.logAutoRotateSessionFileDecision({
        ...baseLog,
        action: "warn",
        conversationId: conversation.conversationId,
        sizeBytes,
        durationMs: Date.now() - startedAt,
        reason: "above-threshold",
        level: "warn",
      });
      return;
    }
    if (params.allowSessionFileRewrite === false) {
      skip(params.rewriteDeferralReason ?? "session-file-rewrite-deferred", sizeBytes);
      return;
    }

    let result: RotateSessionStorageResult | RotateSessionStorageWithBackupResult;
    try {
      result = this.host.config.autoRotateSessionFiles.createBackups
        ? await this.rotateSessionStorageWithBackup({
            sessionId,
            sessionKey,
            sessionFile,
            lockTimeoutMs: AUTO_ROTATE_DATABASE_LOCK_TIMEOUT_MS,
          })
        : await this.rotateSessionStorage({
            sessionId,
            sessionKey,
            sessionFile,
          });
    } catch (error) {
      this.logAutoRotateSessionFileDecision({
        ...baseLog,
        action: "warn",
        conversationId: conversation.conversationId,
        sizeBytes,
        durationMs: Date.now() - startedAt,
        reason: "rotate-threw",
        error: describeLogError(error),
        level: "warn",
      });
      return;
    }

    if (result.kind === "rotated") {
      if (result.checkpointSize >= thresholdBytes) {
        this.oversizedAutoRotateCheckpointByQueueKey.set(queueKey, result.checkpointSize);
      } else {
        this.oversizedAutoRotateCheckpointByQueueKey.delete(queueKey);
      }
      const conversationId = "currentConversationId" in result
        ? result.currentConversationId
        : result.conversationId;
      this.logAutoRotateSessionFileDecision({
        ...baseLog,
        action: "rotate",
        conversationId,
        sizeBytes,
        durationMs: Date.now() - startedAt,
        backupPath: "backupPath" in result ? result.backupPath : undefined,
        bytesRemoved: result.bytesRemoved,
        preservedTailMessageCount: result.preservedTailMessageCount,
        checkpointSize: result.checkpointSize,
        currentMessageCount: "currentMessageCount" in result ? result.currentMessageCount : undefined,
      });
      return;
    }

    this.logAutoRotateSessionFileDecision({
      ...baseLog,
      action: "warn",
      conversationId: "currentConversationId" in result
        ? result.currentConversationId ?? conversation.conversationId
        : conversation.conversationId,
      sizeBytes,
      durationMs: Date.now() - startedAt,
      backupPath: "backupPath" in result ? result.backupPath : undefined,
      currentMessageCount: "currentMessageCount" in result ? result.currentMessageCount : undefined,
      reason: result.kind,
      error: result.reason,
      level: "warn",
    });
  }

  /** Emit the compact startup auto-rotate summary line. */
  private logStartupAutoRotateSummary(params: {
    startedAt: number;
    thresholdBytes: number;
    scanned: number;
    eligible: number;
    rotated: number;
    warned: number;
    skipped: number;
    bytesRemoved: number;
    backupPath?: string;
    backupCreated?: number;
    reason?: string;
  }): void {
    this.logAutoRotateSessionFileDecision({
      phase: "startup",
      action: "summary",
      thresholdBytes: params.thresholdBytes,
      durationMs: Date.now() - params.startedAt,
      scanned: params.scanned,
      eligible: params.eligible,
      rotated: params.rotated,
      warned: params.warned,
      skipped: params.skipped,
      backupPath: params.backupPath,
      bytesRemoved: params.bytesRemoved,
      backupCreated: params.backupCreated,
      reason: params.reason,
    });
  }

  /** Quietly intersect one indexed startup candidate with active LCM ownership. */
  private async prepareStartupAutoRotateCandidate(params: {
    candidate: StartupSessionFileCandidate;
    startedAt: number;
    thresholdBytes: number;
  }): Promise<
    | { kind: "eligible"; candidate: StartupAutoRotateCandidate }
    | { kind: "skipped" }
    | { kind: "warned" }
  > {
    const sessionId = params.candidate.sessionId?.trim();
    const sessionKey = params.candidate.sessionKey?.trim();
    const sessionFile = params.candidate.sessionFile?.trim();
    if (!sessionId || !sessionKey || !sessionFile) {
      return { kind: "skipped" };
    }
    if (this.host.shouldIgnoreSession({ sessionId, sessionKey }) || this.host.isStatelessSession(sessionKey)) {
      return { kind: "skipped" };
    }

    let conversation: ConversationRecord | null;
    try {
      conversation = await this.host.conversationStore.getConversationForSession({ sessionId, sessionKey });
    } catch (error) {
      this.logAutoRotateSessionFileDecision({
        phase: "startup",
        action: "warn",
        sessionId,
        sessionKey,
        sessionFile,
        thresholdBytes: params.thresholdBytes,
        durationMs: Date.now() - params.startedAt,
        reason: "conversation-lookup-failed",
        error: describeLogError(error),
        level: "warn",
      });
      return { kind: "warned" };
    }
    if (!conversation?.active) {
      return { kind: "skipped" };
    }

    const bootstrapState = await this.host.summaryStore.getConversationBootstrapState(
      conversation.conversationId,
    );
    const bootstrapPath = bootstrapState?.sessionFilePath?.trim();
    if (
      !bootstrapPath ||
      normalizeSessionFilePathForComparison(bootstrapPath) !==
        normalizeSessionFilePathForComparison(sessionFile)
    ) {
      return { kind: "skipped" };
    }

    let sizeBytes: number;
    try {
      sizeBytes = (await stat(sessionFile)).size;
    } catch (error) {
      if (isMissingFileError(error)) {
        return { kind: "skipped" };
      }
      this.logAutoRotateSessionFileDecision({
        phase: "startup",
        action: "warn",
        sessionId,
        sessionKey,
        conversationId: conversation.conversationId,
        sessionFile,
        thresholdBytes: params.thresholdBytes,
        durationMs: Date.now() - params.startedAt,
        reason: "session-file-stat-failed",
        error: describeLogError(error),
        level: "warn",
      });
      return { kind: "warned" };
    }
    if (sizeBytes <= params.thresholdBytes) {
      this.oversizedAutoRotateCheckpointByQueueKey.delete(
        this.host.resolveSessionQueueKey(sessionId, sessionKey),
      );
      return { kind: "skipped" };
    }

    return {
      kind: "eligible",
      candidate: {
        sessionId,
        sessionKey,
        sessionFile,
        conversationId: conversation.conversationId,
        sizeBytes,
        currentMessageCount: await this.host.conversationStore.getMessageCount(conversation.conversationId),
      },
    };
  }

  /** Enter all affected session queues before taking the startup batch DB backup. */
  private async withStartupAutoRotateSessionQueues<T>(
    candidates: StartupAutoRotateCandidate[],
    operation: () => Promise<T>,
  ): Promise<T> {
    const queueKeys = Array.from(
      new Set(candidates.map((candidate) => this.host.resolveSessionQueueKey(candidate.sessionId, candidate.sessionKey))),
    ).sort();
    const enter = async (index: number): Promise<T> => {
      if (index >= queueKeys.length) {
        return operation();
      }
      return this.host.withSessionQueue(queueKeys[index]!, () => enter(index + 1));
    };
    return enter(0);
  }

  /** Rotate startup candidates with one pre-mutation LCM database backup. */
  private async rotateStartupAutoRotateBatch(params: {
    candidates: StartupAutoRotateCandidate[];
    startedAt: number;
    thresholdBytes: number;
  }): Promise<StartupAutoRotateBatchResult> {
    const empty = (): StartupAutoRotateBatchResult => ({
      rotated: 0,
      warned: 0,
      bytesRemoved: 0,
      backupCreated: 0,
    });
    if (params.candidates.length === 0) {
      return empty();
    }

    try {
      return await this.withStartupAutoRotateSessionQueues(params.candidates, async () => {
        const result: StartupAutoRotateBatchResult = {
          rotated: 0,
          warned: 0,
          bytesRemoved: 0,
          backupCreated: 0,
        };
        const readyCandidates: StartupAutoRotateCandidate[] = [];

        for (const candidate of params.candidates) {
          const transcriptCoverage = await this.reconcileRawTranscriptForRotate({
            sessionId: candidate.sessionId,
            sessionKey: candidate.sessionKey,
            sessionFile: candidate.sessionFile,
            sessionQueueAlreadyHeld: true,
          });
          if (transcriptCoverage.kind === "unavailable") {
            result.warned += 1;
            this.logAutoRotateSessionFileDecision({
              phase: "startup",
              action: "warn",
              sessionId: candidate.sessionId,
              sessionKey: candidate.sessionKey,
              conversationId: candidate.conversationId,
              sessionFile: candidate.sessionFile,
              sizeBytes: candidate.sizeBytes,
              thresholdBytes: params.thresholdBytes,
              durationMs: Date.now() - params.startedAt,
              currentMessageCount: candidate.currentMessageCount,
              reason: "transcript-reconcile-unavailable",
              error: transcriptCoverage.reason,
              level: "warn",
            });
            continue;
          }

          const coverage = await this.compactRawContextOutsideFreshTailForRotate({
            sessionId: candidate.sessionId,
            sessionKey: candidate.sessionKey,
          });
          if (coverage.kind === "unavailable") {
            result.warned += 1;
            this.logAutoRotateSessionFileDecision({
              phase: "startup",
              action: "warn",
              sessionId: candidate.sessionId,
              sessionKey: candidate.sessionKey,
              conversationId: candidate.conversationId,
              sessionFile: candidate.sessionFile,
              sizeBytes: candidate.sizeBytes,
              thresholdBytes: params.thresholdBytes,
              durationMs: Date.now() - params.startedAt,
              currentMessageCount: candidate.currentMessageCount,
              reason: "coverage-unavailable",
              error: coverage.reason,
              level: "warn",
            });
            continue;
          }

          readyCandidates.push(candidate);
        }

        if (readyCandidates.length === 0) {
          return result;
        }

        const lockedResult = await withExclusiveDatabaseLock(
          this.host.db,
          { timeoutMs: AUTO_ROTATE_DATABASE_LOCK_TIMEOUT_MS },
          async () => {
            if (this.host.db.isTransaction) {
              this.logAutoRotateSessionFileDecision({
                phase: "startup",
                action: "warn",
                thresholdBytes: params.thresholdBytes,
                durationMs: Date.now() - params.startedAt,
                reason: "database-transaction-active",
                level: "warn",
              });
              return { ...empty(), warned: readyCandidates.length };
            }

            let backupPath: string | undefined;
            let backupCreated = 0;
            if (this.host.config.autoRotateSessionFiles.createBackups) {
              const backup = this.createRotateDatabaseBackup();
              if (backup.outcome !== "created") {
                this.logAutoRotateSessionFileDecision({
                  phase: "startup",
                  action: "warn",
                  thresholdBytes: params.thresholdBytes,
                  durationMs: Date.now() - params.startedAt,
                  reason: backup.outcome,
                  ...(backup.outcome === "backup-failed"
                    ? { error: describeLogError(backup.error) }
                    : {}),
                  level: "warn",
                });
                return { ...empty(), warned: readyCandidates.length };
              }
              backupPath = backup.backupPath;
              backupCreated = 1;
            }

            const locked: StartupAutoRotateBatchResult = {
              rotated: 0,
              warned: 0,
              bytesRemoved: 0,
              backupPath,
              backupCreated,
            };
            for (const candidate of readyCandidates) {
              let rotateResult: RotateSessionStorageResult;
              try {
                rotateResult = await this.rotateSessionStorageWhileHoldingDatabaseLock({
                  sessionId: candidate.sessionId,
                  sessionKey: candidate.sessionKey,
                  sessionFile: candidate.sessionFile,
                });
              } catch (error) {
                locked.warned += 1;
                this.logAutoRotateSessionFileDecision({
                  phase: "startup",
                  action: "warn",
                  sessionId: candidate.sessionId,
                  sessionKey: candidate.sessionKey,
                  conversationId: candidate.conversationId,
                  sessionFile: candidate.sessionFile,
                  sizeBytes: candidate.sizeBytes,
                  thresholdBytes: params.thresholdBytes,
                  durationMs: Date.now() - params.startedAt,
                  backupPath,
                  currentMessageCount: candidate.currentMessageCount,
                  reason: "rotate-threw",
                  error: describeLogError(error),
                  level: "warn",
                });
                continue;
              }

              if (rotateResult.kind === "unavailable") {
                locked.warned += 1;
                this.logAutoRotateSessionFileDecision({
                  phase: "startup",
                  action: "warn",
                  sessionId: candidate.sessionId,
                  sessionKey: candidate.sessionKey,
                  conversationId: candidate.conversationId,
                  sessionFile: candidate.sessionFile,
                  sizeBytes: candidate.sizeBytes,
                  thresholdBytes: params.thresholdBytes,
                  durationMs: Date.now() - params.startedAt,
                  backupPath,
                  currentMessageCount: candidate.currentMessageCount,
                  reason: "unavailable",
                  error: rotateResult.reason,
                  level: "warn",
                });
                continue;
              }

              locked.rotated += 1;
              locked.bytesRemoved += rotateResult.bytesRemoved;
              const queueKey = this.host.resolveSessionQueueKey(candidate.sessionId, candidate.sessionKey);
              if (rotateResult.checkpointSize >= params.thresholdBytes) {
                this.oversizedAutoRotateCheckpointByQueueKey.set(queueKey, rotateResult.checkpointSize);
              } else {
                this.oversizedAutoRotateCheckpointByQueueKey.delete(queueKey);
              }
              this.logAutoRotateSessionFileDecision({
                phase: "startup",
                action: "rotate",
                sessionId: candidate.sessionId,
                sessionKey: candidate.sessionKey,
                conversationId: rotateResult.conversationId,
                sessionFile: candidate.sessionFile,
                sizeBytes: candidate.sizeBytes,
                thresholdBytes: params.thresholdBytes,
                durationMs: Date.now() - params.startedAt,
                backupPath,
                bytesRemoved: rotateResult.bytesRemoved,
                preservedTailMessageCount: rotateResult.preservedTailMessageCount,
                checkpointSize: rotateResult.checkpointSize,
                currentMessageCount: candidate.currentMessageCount,
              });
            }
            return locked;
          },
        );
        return {
          rotated: result.rotated + lockedResult.rotated,
          warned: result.warned + lockedResult.warned,
          bytesRemoved: result.bytesRemoved + lockedResult.bytesRemoved,
          backupPath: lockedResult.backupPath,
          backupCreated: result.backupCreated + lockedResult.backupCreated,
        };
      });
    } catch (error) {
      if (error instanceof DatabaseTransactionTimeoutError) {
        this.logAutoRotateSessionFileDecision({
          phase: "startup",
          action: "warn",
          thresholdBytes: params.thresholdBytes,
          durationMs: Date.now() - params.startedAt,
          reason: "database-lock-timeout",
          error: describeLogError(error),
          level: "warn",
        });
        return { ...empty(), warned: 1 };
      }
      throw error;
    }
  }

  /** Scan OpenClaw-indexed startup transcripts and rotate oversized active LCM sessions. */
  async autoRotateManagedSessionFilesAtStartup(params?: {
    listStartupSessionFileCandidates?: () => Promise<StartupSessionFileCandidate[]>;
  }): Promise<void> {
    const startedAt = Date.now();
    const thresholdBytes = this.host.config.autoRotateSessionFiles.sizeBytes;
    const mode = this.getAutoRotateSessionFileMode("startup");
    const summary = {
      scanned: 0,
      eligible: 0,
      rotated: 0,
      warned: 0,
      skipped: 0,
      bytesRemoved: 0,
      backupPath: undefined as string | undefined,
      backupCreated: 0,
    };
    const logSummary = (reason?: string): void =>
      this.logStartupAutoRotateSummary({
        startedAt,
        thresholdBytes,
        ...summary,
        reason,
      });

    if (!this.host.config.autoRotateSessionFiles.enabled || mode === "off") {
      logSummary(this.host.config.autoRotateSessionFiles.enabled ? "mode-off" : "disabled");
      return;
    }
    if (!this.host.info.ownsCompaction) {
      logSummary("engine-unhealthy");
      return;
    }
    const listStartupSessionFileCandidates =
      params?.listStartupSessionFileCandidates ?? this.host.deps.listStartupSessionFileCandidates;
    if (!listStartupSessionFileCandidates) {
      logSummary("no-indexed-session-provider");
      return;
    }

    this.host.ensureMigrated();
    let indexedCandidates: StartupSessionFileCandidate[];
    try {
      indexedCandidates = await listStartupSessionFileCandidates();
    } catch (error) {
      summary.warned += 1;
      this.logAutoRotateSessionFileDecision({
        phase: "startup",
        action: "warn",
        thresholdBytes,
        durationMs: Date.now() - startedAt,
        reason: "candidate-scan-failed",
        error: describeLogError(error),
        level: "warn",
      });
      logSummary("candidate-scan-failed");
      return;
    }

    const rotateCandidates: StartupAutoRotateCandidate[] = [];
    for (const candidate of indexedCandidates) {
      summary.scanned += 1;
      const prepared = await this.prepareStartupAutoRotateCandidate({
        candidate,
        startedAt,
        thresholdBytes,
      });
      if (prepared.kind === "eligible") {
        summary.eligible += 1;
        if (mode === "warn") {
          summary.warned += 1;
          this.logAutoRotateSessionFileDecision({
            phase: "startup",
            action: "warn",
            sessionId: prepared.candidate.sessionId,
            sessionKey: prepared.candidate.sessionKey,
            conversationId: prepared.candidate.conversationId,
            sessionFile: prepared.candidate.sessionFile,
            sizeBytes: prepared.candidate.sizeBytes,
            thresholdBytes,
            durationMs: Date.now() - startedAt,
            currentMessageCount: prepared.candidate.currentMessageCount,
            reason: "above-threshold",
            level: "warn",
          });
        } else {
          rotateCandidates.push(prepared.candidate);
        }
      } else if (prepared.kind === "warned") {
        summary.warned += 1;
      } else {
        summary.skipped += 1;
      }
    }

    const batch = await this.rotateStartupAutoRotateBatch({
      candidates: rotateCandidates,
      startedAt,
      thresholdBytes,
    });
    summary.rotated += batch.rotated;
    summary.warned += batch.warned;
    summary.bytesRemoved += batch.bytesRemoved;
    summary.backupPath = batch.backupPath;
    summary.backupCreated += batch.backupCreated;
    logSummary("completed");
  }

  /**
   * Rewrite the active transcript into a compact suffix-preserving form.
   *
   * Rotate is transcript maintenance, not conversation replacement. We keep the
   * current conversation id and LCM context intact, then rebuild the transcript
   * so only the latest raw tail plus current session settings remain on disk.
   */
  private async rewriteTranscriptForRotate(params: {
    conversationId: number;
    sessionFile: string;
  }): Promise<RotateTranscriptRewriteResult> {
    const { header, entries: branch } = await readLeafPathRawEntries(params.sessionFile);
    if (!header) {
      // SessionManager.open used to synthesize a header (and rewrite the
      // file) here; reading is now side-effect free, so a headerless file is
      // the host's problem to recover, not ours to rotate.
      throw new Error("session file has no session header; refusing to rotate");
    }
    const originalStats = await stat(params.sessionFile);

    const messageIndices: number[] = [];
    for (let index = 0; index < branch.length; index += 1) {
      if (branch[index]?.type === "message") {
        messageIndices.push(index);
      }
    }

    const configuredTailMessageCount = normalizeRotateTailMessageCount(
      this.host.config.freshTailCount,
      messageIndices.length,
    );
    const configuredTailStartOffset = messageIndices.length - configuredTailMessageCount;
    const latestUserOffset = messageIndices.findLastIndex((index) => {
      const entry = branch[index];
      return entry?.type === "message" && asRecord(entry.message)?.role === "user";
    });
    const tailStartOffset =
      latestUserOffset >= 0
        ? Math.min(configuredTailStartOffset, latestUserOffset)
        : configuredTailStartOffset;
    const keepTailMessageCount = messageIndices.length - tailStartOffset;
    const anchorIndex =
      keepTailMessageCount > 0
        ? (messageIndices[tailStartOffset] ?? branch.length)
        : branch.length;

    const latestPreludeEntries = new Map<string, TranscriptRawEntry>();
    for (let index = 0; index < anchorIndex; index += 1) {
      const entry = branch[index];
      if (
        entry &&
        typeof entry.type === "string" &&
        isRotatePreservedEntryType(entry.type) &&
        entry.type !== "message"
      ) {
        latestPreludeEntries.set(entry.type, entry);
      }
    }

    const entriesToKeep: Array<(typeof branch)[number]> = [];
    for (const type of ["session_info", "model_change", "thinking_level_change"] as const) {
      const entry = latestPreludeEntries.get(type);
      if (entry) {
        entriesToKeep.push({ ...entry });
      }
    }

    for (let index = anchorIndex; index < branch.length; index += 1) {
      const entry = branch[index];
      if (entry && typeof entry.type === "string" && isRotatePreservedEntryType(entry.type)) {
        entriesToKeep.push({ ...entry });
      }
    }

    while (entriesToKeep.length > 0 && entriesToKeep[entriesToKeep.length - 1]?.type !== "message") {
      entriesToKeep.pop();
    }

    let previousEntryId: string | null = null;
    const linearizedEntries = entriesToKeep.map((entry): TranscriptRawEntry => {
      const nextEntry: TranscriptRawEntry = {
        ...entry,
        parentId: previousEntryId,
      };
      previousEntryId = typeof nextEntry.id === "string" ? nextEntry.id : previousEntryId;
      return nextEntry;
    });

    const serialized = [
      JSON.stringify(header),
      ...linearizedEntries.map((entry) => JSON.stringify(entry)),
    ].join("\n") + "\n";
    await writeFile(params.sessionFile, serialized, "utf8");

    const rewrittenStats = await stat(params.sessionFile);
    await this.host.refreshBootstrapState({
      conversationId: params.conversationId,
      sessionFile: params.sessionFile,
      fileStats: {
        size: rewrittenStats.size,
        mtimeMs: rewrittenStats.mtimeMs,
      },
    });

    return {
      checkpointSize: rewrittenStats.size,
      bytesRemoved: Math.max(0, originalStats.size - rewrittenStats.size),
      preservedTailMessageCount: keepTailMessageCount,
    };
  }

  /**
   * Rotate the active session transcript while a write transaction is already open.
   *
   * This keeps the transcript rewrite and checkpoint update in one place so the
   * command path can reuse it after taking a faithful backup on the shared
   * connection.
   */
  private async rotateSessionStorageInActiveTransaction(params: {
    sessionId: string;
    sessionKey: string;
    sessionFile: string;
  }): Promise<RotateSessionStorageResult> {
    const { sessionId, sessionKey } = params;
    const current = await this.host.conversationStore.getConversationForSession({
      sessionId,
      sessionKey,
    });
    if (!current?.active) {
      return {
        kind: "unavailable",
        reason: "No active Lossless Claw conversation is stored for the current session.",
      };
    }

    try {
      const rewriteResult = await this.rewriteTranscriptForRotate({
        conversationId: current.conversationId,
        sessionFile: params.sessionFile,
      });
      this.host.deps.log.info(
        `[lcm] rotate: rewrote transcript for conversation=${current.conversationId} session=${sessionId} sessionKey=${sessionKey} preservedTailMessages=${rewriteResult.preservedTailMessageCount} checkpointSize=${rewriteResult.checkpointSize} bytesRemoved=${rewriteResult.bytesRemoved}`,
      );
      return {
        kind: "rotated",
        conversationId: current.conversationId,
        preservedTailMessageCount: rewriteResult.preservedTailMessageCount,
        checkpointSize: rewriteResult.checkpointSize,
        bytesRemoved: rewriteResult.bytesRemoved,
      };
    } catch (error) {
      return {
        kind: "unavailable",
        reason: `Lossless Claw could not rotate the current session transcript: ${describeLogError(error)}`,
      };
    }
  }

  /**
   * Summarize raw context that would be removed from the host transcript.
   *
   * Rotate preserves the configured fresh tail in JSONL, expanding through the
   * newest user when needed to keep its assistant/tool suffix together. Before
   * rewriting that file, force leaf-only compaction until every older raw
   * context item has been replaced by a leaf summary. This avoids unrelated
   * condensation work while making the transcript trim depend on LCM summary
   * coverage.
   */
  private async compactRawContextOutsideFreshTailForRotate(params: {
    sessionId: string;
    sessionKey: string;
    runtimeContext?: Record<string, unknown>;
    legacyParams?: Record<string, unknown>;
  }): Promise<
    | { kind: "ready"; conversationId: number; leafPasses: number }
    | { kind: "unavailable"; reason: string }
  > {
    const current = await this.host.conversationStore.getConversationForSession({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
    });
    if (!current?.active) {
      return {
        kind: "unavailable",
        reason: "No active Lossless Claw conversation is stored for the current session.",
      };
    }

    const initialContextItems = await this.host.summaryStore.getContextItems(current.conversationId);
    const leafTrigger = await this.host.compaction.evaluateLeafTrigger(current.conversationId, 1);
    if (leafTrigger.rawTokensOutsideTail <= 0) {
      return { kind: "ready", conversationId: current.conversationId, leafPasses: 0 };
    }

    const maxLeafPasses = initialContextItems.filter((item) => item.itemType === "message").length;
    if (maxLeafPasses === 0) {
      return { kind: "ready", conversationId: current.conversationId, leafPasses: 0 };
    }

    const telemetry = await this.host.compactionTelemetryStore.getConversationCompactionTelemetry(
      current.conversationId,
    );
    const telemetryLegacyParams =
      telemetry?.provider || telemetry?.model
        ? {
            ...(telemetry.provider ? { provider: telemetry.provider } : {}),
            ...(telemetry.model ? { model: telemetry.model } : {}),
          }
        : undefined;
    const legacyParams =
      asRecord(params.runtimeContext) ?? params.legacyParams ?? telemetryLegacyParams;
    const { summarize, summaryModel, breakerKey } = await this.host.resolveSummarize({
      legacyParams: this.host.buildSummarizerLegacyParams({
        legacyParams,
        sessionKey: params.sessionKey,
      }),
      breakerScope: this.host.resolveSessionQueueKey(params.sessionId, params.sessionKey),
    });
    if (breakerKey && this.host.compactionGuards.isCircuitBreakerOpen(breakerKey)) {
      return {
        kind: "unavailable",
        reason: "Lossless Claw could not summarize raw context before rotate because the summary provider circuit breaker is open.",
      };
    }
    const tokenBudget = this.host.applyAssemblyBudgetCap(128_000);
    let leafPasses = 0;

    while (leafPasses <= maxLeafPasses) {
      let result: Awaited<ReturnType<CompactionEngine["compactLeaf"]>>;
      try {
        result = await this.host.compaction.compactLeaf({
          conversationId: current.conversationId,
          tokenBudget,
          summarize,
          force: true,
          allowCondensedPasses: false,
          summaryModel,
        });
      } catch (err) {
        if (err instanceof LcmSummarySpendLimitError) {
          return {
            kind: "unavailable",
            reason:
              `Lossless Claw could not summarize raw context before rotate because summary spend backoff is open until ${err.backoffUntil.toISOString()}.`,
          };
        }
        throw err;
      }
      if (!result.actionTaken) {
        if (result.authFailure) {
          if (breakerKey) {
            this.host.compactionGuards.recordCompactionAuthFailure(breakerKey);
          }
          return {
            kind: "unavailable",
            reason: "Lossless Claw could not summarize raw context before rotate because the summary provider rejected authentication.",
          };
        }
        if (leafPasses > 0) {
          this.host.deps.log.info(
            `[lcm] rotate: summarized raw context before transcript rewrite conversation=${current.conversationId} session=${params.sessionId} sessionKey=${params.sessionKey} leafPasses=${leafPasses}`,
          );
        }
        return { kind: "ready", conversationId: current.conversationId, leafPasses };
      }
      if (breakerKey) {
        this.host.compactionGuards.recordCompactionSuccess(breakerKey);
      }
      leafPasses += 1;
    }

    return {
      kind: "unavailable",
      reason:
        "Lossless Claw stopped rotate before rewriting the transcript because raw context outside the fresh tail could not be fully summarized.",
    };
  }

  /**
   * Import transcript rows not yet present in LCM before rotate trims JSONL.
   *
   * Foreground turns can leave the backing transcript ahead of persisted LCM
   * rows. Rotate must compact transcript-covered history, not only rows that
   * happened to be imported before the slash command ran.
   */
  private async reconcileRawTranscriptForRotate(params: {
    sessionId: string;
    sessionKey: string;
    sessionFile: string;
    sessionQueueAlreadyHeld?: boolean;
  }): Promise<{ kind: "ready"; importedMessages: number } | { kind: "unavailable"; reason: string }> {
    try {
      const reconcileParams = {
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        sessionFile: params.sessionFile,
        allowNoAnchorImportOnCheckpointMissing: true,
      };
      const result = params.sessionQueueAlreadyHeld
        ? await this.host.reconcileTranscriptTailForAfterTurnInSessionQueue(reconcileParams)
        : await this.host.reconcileTranscriptTailForAfterTurn(reconcileParams);
      if (result.blockedByImportCap) {
        return {
          kind: "unavailable",
          reason:
            "Lossless Claw could not reconcile transcript messages before rotate because the replay import cap was reached.",
        };
      }
      if (!result.hasOverlap && result.importedMessages === 0) {
        return {
          kind: "unavailable",
          reason:
            "Lossless Claw could not prove transcript coverage before rotate because transcript reconciliation found no safe overlap and imported no messages.",
        };
      }
      if (result.importedMessages > 0) {
        this.host.deps.log.info(
          `[lcm] rotate: reconciled transcript before summary coverage session=${params.sessionId} sessionKey=${params.sessionKey} sessionFile=${params.sessionFile} importedMessages=${result.importedMessages}`,
        );
      }
      return { kind: "ready", importedMessages: result.importedMessages };
    } catch (err) {
      return {
        kind: "unavailable",
        reason: `Lossless Claw could not reconcile transcript messages before rotate: ${describeLogError(err)}`,
      };
    }
  }

  async rotateSessionStorage(params: {
    sessionId?: string;
    sessionKey?: string;
    sessionFile: string;
    runtimeContext?: Record<string, unknown>;
    legacyParams?: Record<string, unknown>;
  }): Promise<RotateSessionStorageResult> {
    const sessionId = params.sessionId?.trim();
    const sessionKey = params.sessionKey?.trim();
    if (!sessionId || !sessionKey) {
      return {
        kind: "unavailable",
        reason: "Lossless Claw needs both the current session id and session key to rotate storage safely.",
      };
    }
    if (this.host.shouldIgnoreSession({ sessionId, sessionKey })) {
      return {
        kind: "unavailable",
        reason: "The current session is excluded by ignoreSessionPatterns, so there is no active LCM conversation to rotate.",
      };
    }
    if (this.host.isStatelessSession(sessionKey)) {
      return {
        kind: "unavailable",
        reason: "The current session is stateless in Lossless Claw, so there is no writable active LCM conversation to rotate.",
      };
    }

    this.host.ensureMigrated();
    return this.host.withSessionQueue(
      this.host.resolveSessionQueueKey(sessionId, sessionKey),
      async () => {
        const transcriptCoverage = await this.reconcileRawTranscriptForRotate({
          sessionId,
          sessionKey,
          sessionFile: params.sessionFile,
          sessionQueueAlreadyHeld: true,
        });
        if (transcriptCoverage.kind === "unavailable") {
          return transcriptCoverage;
        }

        const coverage = await this.compactRawContextOutsideFreshTailForRotate({
          sessionId,
          sessionKey,
          runtimeContext: params.runtimeContext,
          legacyParams: params.legacyParams,
        });
        if (coverage.kind === "unavailable") {
          return coverage;
        }
        return this.host.conversationStore.withTransaction(() =>
          this.rotateSessionStorageInActiveTransaction({
            sessionId,
            sessionKey,
            sessionFile: params.sessionFile,
          }),
        );
      },
    );
  }

  /**
   * Rotate session storage while the caller already holds exclusive DB access.
   *
   * The caller is responsible for ordering any higher-level queues before
   * entering this helper. This method only manages the rotate write
   * transaction on the shared connection.
   */
  async rotateSessionStorageWhileHoldingDatabaseLock(params: {
    sessionId?: string;
    sessionKey?: string;
    sessionFile: string;
  }): Promise<RotateSessionStorageResult> {
    const sessionId = params.sessionId?.trim();
    const sessionKey = params.sessionKey?.trim();
    if (!sessionId || !sessionKey) {
      return {
        kind: "unavailable",
        reason: "Lossless Claw needs both the current session id and session key to rotate storage safely.",
      };
    }
    if (this.host.shouldIgnoreSession({ sessionId, sessionKey })) {
      return {
        kind: "unavailable",
        reason: "The current session is excluded by ignoreSessionPatterns, so there is no active LCM conversation to rotate.",
      };
    }
    if (this.host.isStatelessSession(sessionKey)) {
      return {
        kind: "unavailable",
        reason: "The current session is stateless in Lossless Claw, so there is no writable active LCM conversation to rotate.",
      };
    }

    this.host.ensureMigrated();
    if (this.host.db.isTransaction) {
      return {
        kind: "unavailable",
        reason:
          "Lossless Claw obtained exclusive rotate access, but the shared database connection is still inside another transaction.",
      };
    }

    let transactionActive = false;
    try {
      this.host.db.exec("BEGIN IMMEDIATE");
      transactionActive = true;
      const result = await this.rotateSessionStorageInActiveTransaction({
        sessionId,
        sessionKey,
        sessionFile: params.sessionFile,
      });
      this.host.db.exec("COMMIT");
      transactionActive = false;
      return result;
    } catch (error) {
      if (transactionActive) {
        this.host.db.exec("ROLLBACK");
      }
      throw error;
    }
  }

  /**
   * Wait for same-session work, cover trimmed raw history, then back up and rotate.
   *
   * This is the safe command path: it preserves session ordering, runs slow
   * reconciliation/summary coverage outside the exclusive database lock, then
   * narrows the lock to backup creation and the final transcript rewrite.
   */
  async rotateSessionStorageWithBackup(params: {
    sessionId?: string;
    sessionKey?: string;
    sessionFile: string;
    lockTimeoutMs: number;
    runtimeContext?: Record<string, unknown>;
    legacyParams?: Record<string, unknown>;
  }): Promise<RotateSessionStorageWithBackupResult> {
    const sessionId = params.sessionId?.trim();
    const sessionKey = params.sessionKey?.trim();
    if (!sessionId || !sessionKey) {
      return {
        kind: "unavailable",
        reason: "Lossless Claw needs both the current session id and session key to rotate storage safely.",
      };
    }
    if (this.host.shouldIgnoreSession({ sessionId, sessionKey })) {
      return {
        kind: "unavailable",
        reason: "The current session is excluded by ignoreSessionPatterns, so there is no active LCM conversation to rotate.",
      };
    }
    if (this.host.isStatelessSession(sessionKey)) {
      return {
        kind: "unavailable",
        reason: "The current session is stateless in Lossless Claw, so there is no writable active LCM conversation to rotate.",
      };
    }

    this.host.ensureMigrated();
    return this.host.withSessionQueue(
      this.host.resolveSessionQueueKey(sessionId, sessionKey),
      async () => {
        const current = await this.host.conversationStore.getConversationForSession({
          sessionId,
          sessionKey,
        });
        if (!current?.active) {
          return {
            kind: "unavailable" as const,
            reason: "No active Lossless Claw conversation is stored for the current session.",
          };
        }
        const currentMessageCount = await this.host.conversationStore.getMessageCount(current.conversationId);

        const transcriptCoverage = await this.reconcileRawTranscriptForRotate({
          sessionId,
          sessionKey,
          sessionFile: params.sessionFile,
          sessionQueueAlreadyHeld: true,
        });
        if (transcriptCoverage.kind === "unavailable") {
          return {
            kind: "unavailable" as const,
            currentConversationId: current.conversationId,
            currentMessageCount,
            reason: transcriptCoverage.reason,
          };
        }

        const coverage = await this.compactRawContextOutsideFreshTailForRotate({
          sessionId,
          sessionKey,
          runtimeContext: params.runtimeContext,
          legacyParams: params.legacyParams,
        });
        if (coverage.kind === "unavailable") {
          return {
            kind: "unavailable" as const,
            currentConversationId: current.conversationId,
            currentMessageCount,
            reason: coverage.reason,
          };
        }

        try {
          return await withExclusiveDatabaseLock(
            this.host.db,
            { timeoutMs: params.lockTimeoutMs },
            async () => {
              if (this.host.db.isTransaction) {
                return {
                  kind: "unavailable" as const,
                  reason:
                    "Lossless Claw obtained exclusive rotate access, but the shared database connection is still inside another transaction.",
                  };
              }

              const lockedCurrent = await this.host.conversationStore.getConversationForSession({
                sessionId,
                sessionKey,
              });
              if (!lockedCurrent?.active) {
                return {
                  kind: "unavailable" as const,
                  currentConversationId: current.conversationId,
                  currentMessageCount,
                  reason: "No active Lossless Claw conversation is stored for the current session.",
                };
              }

              const backup = this.createRotateDatabaseBackup();
              if (backup.outcome === "backup-failed") {
                return {
                  kind: "backup_failed" as const,
                  currentConversationId: lockedCurrent.conversationId,
                  currentMessageCount,
                  reason: describeLogError(backup.error),
                };
              }
              if (backup.outcome === "backup-unavailable") {
                return {
                  kind: "unavailable" as const,
                  currentConversationId: lockedCurrent.conversationId,
                  currentMessageCount,
                  reason: "Lossless Claw could not create the rotate backup.",
                };
              }
              const backupPath = backup.backupPath;

              let rotateResult: RotateSessionStorageResult;
              try {
                rotateResult = await this.rotateSessionStorageWhileHoldingDatabaseLock({
                  sessionId,
                  sessionKey,
                  sessionFile: params.sessionFile,
                });
              } catch (error) {
                return {
                  kind: "rotate_failed" as const,
                  currentConversationId: lockedCurrent.conversationId,
                  currentMessageCount,
                  backupPath,
                  reason: describeLogError(error),
                };
              }
              if (rotateResult.kind === "unavailable") {
                return {
                  kind: "unavailable" as const,
                  currentConversationId: lockedCurrent.conversationId,
                  currentMessageCount,
                  backupPath,
                  reason: rotateResult.reason,
                };
              }

              return {
                kind: "rotated" as const,
                currentConversationId: lockedCurrent.conversationId,
                currentMessageCount,
                backupPath,
                preservedTailMessageCount: rotateResult.preservedTailMessageCount,
                checkpointSize: rotateResult.checkpointSize,
                bytesRemoved: rotateResult.bytesRemoved,
              };
            },
          );
        } catch (error) {
          if (error instanceof DatabaseTransactionTimeoutError) {
            return {
              kind: "unavailable",
              reason: `Lossless Claw waited ${Math.floor(params.lockTimeoutMs / 1000)}s for the database to become idle, but another transaction never finished.`,
            };
          }
          throw error;
        }
      },
    );
  }
}

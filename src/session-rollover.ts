/**
 * Session rollover detection: recovers lifecycle splits the host missed —
 * stable session keys whose tracked transcript file disappeared, isolated
 * cron lanes whose runtime UUID changed, and ambiguous session-key runtime
 * rollovers that need a freshness check before rotating the conversation.
 *
 * Extracted from engine.ts (Phase 3 of the engine decomposition).
 */
import { readdir, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { isHeartbeatNoiseContent } from "./heartbeat-filter.js";
import { describeLogError } from "./lcm-log.js";
import { isLikelyInjectedDeliveryOnlyTranscript, toStoredMessage } from "./message-content.js";
import { createBootstrapEntryHash, messageIdentity } from "./message-signatures.js";
import type { AgentMessage } from "./openclaw-bridge.js";
import { isIsolatedCronSessionKey } from "./session-patterns.js";
import type { ArchiveCause, ConversationStore } from "./store/conversation-store.js";
import { getTranscriptEntryMeta } from "./transcript.js";
import { isMissingFileError } from "./value-utils.js";
import type { SummaryStore } from "./store/summary-store.js";
import type { LcmDependencies } from "./types.js";

export const AMBIGUOUS_SESSION_KEY_RUNTIME_ROLLOVER_REASON =
  "ambiguous session-key runtime rollover";
/**
 * How many recent persisted messages an ambiguous-rollover freshness check
 * compares against the new transcript. Wide enough that a continuation of
 * this conversation cannot plausibly avoid every recent message, small
 * enough to stay cheap on conversations with thousands of rows.
 */
const AMBIGUOUS_ROLLOVER_OVERLAP_WINDOW = 50;
/**
 * Widened fallback window used when the recent window contains no
 * lineage-discriminating content (e.g. a lane that idled on heartbeat
 * traffic before freezing).
 */
const AMBIGUOUS_ROLLOVER_OVERLAP_WIDE_WINDOW = 500;

/**
 * A single-occurrence identity match only proves a foreign/conflicting
 * transcript when the shared content is itself substantial. Trivial,
 * generic content (health-check pings, "ok", "test") recurs by coincidence
 * across genuinely unrelated sessions, so — like heartbeat noise — it
 * cannot discriminate lineage. This floor only matters in combination with
 * deliberate-rollover evidence (see `hasDeliberateRolloverEvidence` below):
 * a substantial overlap (e.g. a specific persisted sentence reappearing)
 * still fails closed even when a /new marker and archive sibling are both
 * present, because that is exactly the shape a foreign session reusing a
 * stale sessionKey would produce.
 *
 * Two known edges, both accepted deliberately: the check is length-only, so
 * a short deployment-specific token that happens to be lineage-discriminating
 * would still bypass; and the bypass can fire even when the trivial message
 * is the only candidate in the new transcript. Both require the
 * deliberate-rollover evidence pair (marker + archive sibling) to be reached
 * at all, which is the actual defense. The threshold value is pinned by a
 * boundary test in rollover-identity-scope.test.ts ("bypasses/fails closed
 * at the trivial-content boundary") so a future bump is a deliberate review
 * point, not an incidental one.
 */
const TRIVIAL_ROLLOVER_OVERLAP_CONTENT_MAX_LENGTH = 8;

function isTrivialRolloverOverlapContent(content: string): boolean {
  return content.trim().length <= TRIVIAL_ROLLOVER_OVERLAP_CONTENT_MAX_LENGTH;
}

export type AmbiguousSessionKeyRuntimeRollover = {
  conversationId: number;
  activeSessionId: string;
  sessionKey: string;
  trackedSessionFile: string;
  /**
   * True when Lossless's own softResetPrunedAt marker AND an on-disk
   * `.reset.` archive sibling both attest that this generation's prior
   * conversation was deliberately archived via /new (see
   * `hasSoftResetArchiveEvidence`). Only used to narrow the identity-overlap
   * freshness gate for trivial content — see
   * `TRIVIAL_ROLLOVER_OVERLAP_CONTENT_MAX_LENGTH` above.
   */
  hasDeliberateRolloverEvidence: boolean;
};

/**
 * Outcome of a tier-2 ambiguous-rollover resolution attempt. `rebound` means
 * the lane healed in place. When it did not, `preserveExpected` is true only for
 * a transient freshness failure (the new transcript cannot be judged yet and the
 * next turn re-evaluates); a conflicting or anomalous failure leaves it false.
 * `alreadyWarned` is true when this exact freeze (same sessionKey + old + new
 * sessionId + freshness reason) already emitted its once-only WARN in a prior
 * call this process, so callers should log any restatement at debug instead.
 */
export type AmbiguousRolloverResolution =
  | { rebound: true }
  | { rebound: false; preserveExpected: boolean; alreadyWarned: boolean };

/**
 * Freshness verdicts where the new transcript simply lacks the evidence to prove
 * a reset YET (no usable timestamps, delivery-only traffic, nothing comparable):
 * the preserve is a pending state the next turn re-evaluates, not a stuck freeze.
 * Every other not-fresh reason (identity overlap, candidate entries predating
 * persistence) is a genuine conflict that does not heal and stays a warn.
 */
const TRANSIENT_AMBIGUOUS_ROLLOVER_FRESHNESS_REASONS = new Set<string>([
  "no-candidate-timestamps",
  "candidate-missing-timestamp",
  "delivery-only-synthetic-transcript",
  "no-comparable-candidate-content",
]);

function isTransientAmbiguousRolloverFreshness(reason: string): boolean {
  return TRANSIENT_AMBIGUOUS_ROLLOVER_FRESHNESS_REASONS.has(reason);
}

/** Engine callback that closes the old conversation and optionally creates its replacement. */
export type ApplySessionReplacementFn = (params: {
  reason: string;
  archiveCause: ArchiveCause;
  sessionId?: string;
  sessionKey?: string;
  nextSessionId?: string;
  nextSessionKey?: string;
  createReplacement: boolean;
  createReplacementWhenMissing?: boolean;
}) => Promise<void>;

export class SessionRolloverDetector {
  /**
   * Once-only WARN memo for ambiguous-rollover freezes: keyed by session
   * generation (sessionKey + old sessionId + new sessionId), valued by the
   * freshness reason last warned about. Nothing about a failed freshness
   * check mutates persisted state (see `evaluateAmbiguousRolloverFreshness`),
   * so without this a still-frozen lane re-derives and re-warns identically
   * on every subsequent bootstrap/afterTurn call. A reason change for the
   * same generation still warns once more, since that is a materially
   * different situation worth surfacing again.
   *
   * Bounded with FIFO eviction at `WARNED_AMBIGUOUS_ROLLOVER_GENERATIONS_CAP`
   * entries (mirrors `TranscriptReconciler`'s `AFTER_TURN_RECONCILE_KEY_CAP`)
   * so a long-lived host process that accumulates many distinct frozen
   * generations doesn't grow this map indefinitely. A generation whose entry
   * gets evicted just re-warns once more on its next call, which is harmless
   * noise, so plain size-capped FIFO is enough; no LRU needed.
   */
  private readonly warnedAmbiguousRolloverGenerations = new Map<string, string>();
  private static readonly WARNED_AMBIGUOUS_ROLLOVER_GENERATIONS_CAP = 500;

  constructor(
    private readonly conversationStore: ConversationStore,
    private readonly summaryStore: SummaryStore,
    private readonly deps: Pick<LcmDependencies, "log">,
    private readonly applySessionReplacement: ApplySessionReplacementFn,
  ) {}

  private ambiguousRolloverGenerationKey(
    rollover: Pick<AmbiguousSessionKeyRuntimeRollover, "sessionKey" | "activeSessionId">,
    sessionId: string,
  ): string {
    return `${rollover.sessionKey} ${rollover.activeSessionId} ${sessionId}`;
  }

  /**
   * True when the host left an on-disk reset archive sibling beside a tracked
   * transcript path (`${basename}.reset.<ts>`). The sibling proves only that
   * the host performed a reset-style archive; callers must pair it with
   * Lossless-owned /new state before treating it as continuity evidence.
   *
   * Host contract (OpenClaw core, confirmed on the 2026.6.10 line and current
   * main): the archive name is minted by `archiveFileOnDisk(filePath, reason)`
   * in `src/gateway/session-transcript-files.fs.ts` as `${filePath}.${reason}.<ts>`,
   * where `reason` is a `SessionArchiveReason` (`src/config/sessions/artifacts.ts`,
   * one of "bak" | "reset" | "deleted"). The host rediscovers its own reset
   * archives by the same `${basename}.reset.` prefix (`findLatestArchivedTranscript`,
   * `src/auto-reply/reply/commands-reset-hooks.ts`). Fails closed (false) on any
   * I/O error.
   */
  private async hasResetArchivedTranscriptSibling(trackedFile: string): Promise<boolean> {
    const prefix = basename(trackedFile);
    if (!prefix) {
      return false;
    }
    const resetPrefix = `${prefix}.reset.`;
    try {
      const entries = await readdir(dirname(trackedFile));
      return entries.some((entry) => entry.startsWith(resetPrefix));
    } catch (err) {
      if (!isMissingFileError(err)) {
        this.deps.log.warn(
          `[lcm] could not scan for archived transcript sibling dir=${dirname(trackedFile)} file=${prefix} error=${describeLogError(err)}`,
        );
      }
      return false;
    }
  }

  private async hasSoftResetArchiveEvidence(params: {
    softResetPrunedAt?: Date | null;
    trackedSessionFile: string;
  }): Promise<boolean> {
    return (
      params.softResetPrunedAt !== null &&
      params.softResetPrunedAt !== undefined &&
      (await this.hasResetArchivedTranscriptSibling(params.trackedSessionFile))
    );
  }

  /**
   * Recover lifecycle splits that the host missed when it pruned a transcript
   * file before Lossless saw a reset/session_end hook. Without this, stable
   * session keys can reattach a new runtime UUID to a stale active conversation
   * and assemble old assistant tails as if they belonged to the new turn.
   */
  async rotateStaleSessionKeyConversationIfTrackedTranscriptMissing(params: {
    phase: "bootstrap" | "assemble" | "afterTurn";
    sessionId: string;
    sessionKey?: string;
    sessionFile?: string;
    createReplacement?: boolean;
  }): Promise<boolean> {
    const normalizedSessionKey = params.sessionKey?.trim();
    if (!normalizedSessionKey) {
      return false;
    }

    const activeByKey = await this.conversationStore.getConversationBySessionKey(
      normalizedSessionKey,
    );
    if (!activeByKey || activeByKey.sessionId === params.sessionId) {
      return false;
    }

    const activeBootstrapState = await this.summaryStore.getConversationBootstrapState(
      activeByKey.conversationId,
    );
    const trackedSessionFile = activeBootstrapState?.sessionFilePath;
    if (typeof trackedSessionFile !== "string" || trackedSessionFile.length === 0) {
      return false;
    }

    const transcriptRotated =
      params.sessionFile === undefined || trackedSessionFile !== params.sessionFile;
    if (!transcriptRotated) {
      return false;
    }

    try {
      await stat(trackedSessionFile);
      return false;
    } catch (err) {
      if (!isMissingFileError(err)) {
        this.deps.log.warn(
          `[lcm] ${params.phase}: could not verify tracked transcript path conversation=${activeByKey.conversationId} file=${trackedSessionFile} error=${describeLogError(err)}`,
        );
        return false;
      }
    }

    // The tracked transcript is gone. Stand the destructive rotate down only
    // when Lossless saw /new pruning for this lane and the host left the
    // corresponding reset archive sibling. A reset suffix alone is ambiguous
    // with /reset, and a deleted suffix is never /new continuity proof.
    if (
      await this.hasSoftResetArchiveEvidence({
        softResetPrunedAt: activeBootstrapState?.softResetPrunedAt,
        trackedSessionFile,
      })
    ) {
      this.deps.log.info(
        `[lcm] ${params.phase}: tracked transcript archived after /new (reset sibling present); deferring to ambiguous-rollover rebind conversation=${activeByKey.conversationId} sessionKey=${normalizedSessionKey} oldSessionId=${activeByKey.sessionId} newSessionId=${params.sessionId} oldFile=${trackedSessionFile}`,
      );
      return false;
    }

    this.deps.log.warn(
      `[lcm] ${params.phase}: detected reset/rollover without prior lifecycle split; rotating conversation=${activeByKey.conversationId} session=${params.sessionId} sessionKey=${normalizedSessionKey} oldSessionId=${activeByKey.sessionId} oldFile=${trackedSessionFile}${params.sessionFile ? ` newFile=${params.sessionFile}` : ""}`,
    );
    await this.applySessionReplacement({
      reason: `${params.phase} session-file rollover fallback`,
      archiveCause: "rollover-fallback",
      sessionId: activeByKey.sessionId,
      sessionKey: normalizedSessionKey,
      nextSessionId: params.sessionId,
      nextSessionKey: normalizedSessionKey,
      createReplacement: params.createReplacement ?? true,
    });
    return true;
  }

  /**
   * Archive the prior active cron run when OpenClaw reuses a scheduler
   * sessionKey for a new isolated runtime session.
   */
  async rotateIsolatedCronConversationIfRuntimeChanged(params: {
    phase: "bootstrap" | "assemble" | "afterTurn";
    sessionId: string;
    sessionKey?: string;
    createReplacement: boolean;
  }): Promise<boolean> {
    const normalizedSessionId = params.sessionId.trim();
    const normalizedSessionKey = params.sessionKey?.trim();
    if (
      !normalizedSessionId ||
      !normalizedSessionKey ||
      !isIsolatedCronSessionKey(normalizedSessionKey)
    ) {
      return false;
    }

    const activeByKey = await this.conversationStore.getConversationBySessionKey(
      normalizedSessionKey,
    );
    if (!activeByKey || activeByKey.sessionId === normalizedSessionId) {
      return false;
    }

    this.deps.log.info(
      `[lcm] ${params.phase}: isolated cron session rollover; archiving conversation=${activeByKey.conversationId} oldSessionId=${activeByKey.sessionId} newSessionId=${normalizedSessionId} sessionKey=${normalizedSessionKey}`,
    );
    await this.applySessionReplacement({
      reason: `${params.phase} isolated cron session rollover`,
      archiveCause: "cron-rotation",
      sessionId: activeByKey.sessionId,
      sessionKey: normalizedSessionKey,
      nextSessionId: normalizedSessionId,
      nextSessionKey: normalizedSessionKey,
      createReplacement: params.createReplacement,
    });
    return true;
  }

  async findAmbiguousSessionKeyRuntimeRollover(params: {
    phase: "bootstrap" | "assemble" | "afterTurn";
    sessionId: string;
    sessionKey?: string;
    sessionFile?: string;
  }): Promise<AmbiguousSessionKeyRuntimeRollover | null> {
    const normalizedSessionKey = params.sessionKey?.trim();
    if (!normalizedSessionKey) {
      return null;
    }

    const activeByKey = await this.conversationStore.getConversationBySessionKey(
      normalizedSessionKey,
    );
    if (!activeByKey || activeByKey.sessionId === params.sessionId) {
      return null;
    }

    const activeBootstrapState = await this.summaryStore.getConversationBootstrapState(
      activeByKey.conversationId,
    );
    const trackedSessionFile = activeBootstrapState?.sessionFilePath;
    if (typeof trackedSessionFile !== "string" || trackedSessionFile.length === 0) {
      return null;
    }

    if (params.sessionFile !== undefined && trackedSessionFile === params.sessionFile) {
      return null;
    }

    // Computed once regardless of whether the tracked file still stat()s:
    // the ENOENT branch below needs it to decide whether a missing file is
    // a handled soft reset, and the freshness gate downstream needs it to
    // narrow identity-overlap for trivial content on a deliberate /new.
    const hasDeliberateRolloverEvidence = await this.hasSoftResetArchiveEvidence({
      softResetPrunedAt: activeBootstrapState?.softResetPrunedAt,
      trackedSessionFile,
    });

    try {
      await stat(trackedSessionFile);
    } catch (err) {
      if (!isMissingFileError(err)) {
        this.deps.log.warn(
          `[lcm] ${params.phase}: could not verify tracked transcript path for ambiguous runtime rollover guard conversation=${activeByKey.conversationId} file=${trackedSessionFile} error=${describeLogError(err)}`,
        );
        return null;
      }
      // The tracked transcript is gone. Treat it as an ambiguous rollover only
      // when Lossless saw /new pruning and the host left a reset archive sibling.
      // A genuine silent loss leaves no sibling. This is a SECONDARY decline:
      // every caller runs rotateStaleSessionKeyConversationIfTrackedTranscript
      // Missing first (see engine.ts), which archives-or-rotates the lane and
      // warns on genuine loss, so that case is already handled there. Log at
      // debug (not warn) for host-contract-drift diagnosis without double-
      // warning or firing on a transient mid-rotation ENOENT.
      if (!hasDeliberateRolloverEvidence) {
        this.deps.log.debug(
          `[lcm] ${params.phase}: tracked transcript missing without /new reset-archive evidence; declining ambiguous-rollover rebind (destructive guard handles genuine loss) conversation=${activeByKey.conversationId} sessionKey=${normalizedSessionKey} file=${trackedSessionFile}`,
        );
        return null;
      }
    }

    return {
      conversationId: activeByKey.conversationId,
      activeSessionId: activeByKey.sessionId,
      sessionKey: normalizedSessionKey,
      trackedSessionFile,
      hasDeliberateRolloverEvidence,
    };
  }

  logAmbiguousSessionKeyRuntimeRollover(params: {
    phase: "bootstrap" | "assemble" | "afterTurn";
    rollover: AmbiguousSessionKeyRuntimeRollover;
    sessionId: string;
    sessionFile?: string;
    // The assemble pass defers freshness judgment to the next bootstrap/afterTurn,
    // so its preserve is a transient per-phase restatement that resolves on the
    // healing pass, not a lane that stayed stuck. Only the genuine freeze (a
    // bootstrap/afterTurn pass that judged the rollover and could not heal it)
    // warns.
    expected?: boolean;
    // True when this exact freeze already emitted its once-only WARN via
    // rotateAmbiguousRolloverForProvablyFreshTranscript's own freshness log
    // for this session generation; a repeat restatement here should not
    // re-warn either.
    alreadyWarned?: boolean;
  }): void {
    const message = `[lcm] ${params.phase}: ${AMBIGUOUS_SESSION_KEY_RUNTIME_ROLLOVER_REASON}; preserving conversation=${params.rollover.conversationId} session=${params.sessionId} sessionKey=${params.rollover.sessionKey} oldSessionId=${params.rollover.activeSessionId} oldFile=${params.rollover.trackedSessionFile}${params.sessionFile ? ` newFile=${params.sessionFile}` : ""}`;
    if (params.expected || params.alreadyWarned) {
      this.deps.log.debug(message);
    } else {
      this.deps.log.warn(message);
    }
  }

  /**
   * Judge whether the new runtime's transcript is provably FRESH relative to
   * a key-conflicting conversation: zero identity overlap with the
   * conversation's recent persisted history AND every timestamped candidate
   * entry postdates the conversation's last persisted message. Freshness is
   * judged on content+time evidence — never on transcript size — so lanes
   * that ran frozen for days (and accumulated history) still qualify.
   * Fails closed on missing evidence.
   */
  private async evaluateAmbiguousRolloverFreshness(params: {
    conversationId: number;
    candidateMessages: AgentMessage[];
    /**
     * True when a /new marker + archive sibling both attest the prior
     * generation was deliberately rotated (see
     * `AmbiguousSessionKeyRuntimeRollover.hasDeliberateRolloverEvidence`).
     * Defaults to false so callers outside the /new soft-reset path (e.g.
     * isolated-cron rollover) keep the unmodified, fully fail-closed check.
     */
    hasDeliberateRolloverEvidence?: boolean;
  }): Promise<{
    fresh: boolean;
    reason: string;
    lastPersistedAt: Date | null;
    firstCandidateAt: number | null;
  }> {
    if (isLikelyInjectedDeliveryOnlyTranscript(params.candidateMessages)) {
      return {
        fresh: false,
        reason: "delivery-only-synthetic-transcript",
        lastPersistedAt: null,
        firstCandidateAt: null,
      };
    }

    // Every candidate must carry a usable timestamp (message timestamp or
    // transcript envelope timestamp); any untimestamped entry means the
    // transcript's age cannot be proven, so fail closed.
    let firstCandidateAt: number | null = null;
    for (const message of params.candidateMessages) {
      const ts = (message as { timestamp?: unknown }).timestamp;
      let resolved: number | null =
        typeof ts === "number" && Number.isFinite(ts) && ts > 0 ? ts : null;
      if (resolved === null) {
        const envelopeTimestamp = getTranscriptEntryMeta(message)?.timestamp;
        if (typeof envelopeTimestamp === "string") {
          const parsed = Date.parse(envelopeTimestamp);
          if (Number.isFinite(parsed) && parsed > 0) {
            resolved = parsed;
          }
        }
      }
      if (resolved === null) {
        return {
          fresh: false,
          reason: "candidate-missing-timestamp",
          lastPersistedAt: null,
          firstCandidateAt,
        };
      }
      firstCandidateAt = firstCandidateAt === null ? resolved : Math.min(firstCandidateAt, resolved);
    }
    if (firstCandidateAt === null) {
      return {
        fresh: false,
        reason: "no-candidate-timestamps",
        lastPersistedAt: null,
        firstCandidateAt,
      };
    }

    const lastPersisted = await this.conversationStore.getLastMessage(params.conversationId);
    if (!lastPersisted) {
      // Nothing persisted to protect: time evidence alone is sufficient and
      // archiving an empty conversation is harmless.
      return { fresh: true, reason: "empty-conversation", lastPersistedAt: null, firstCandidateAt };
    }
    if (firstCandidateAt <= lastPersisted.createdAt.getTime()) {
      return {
        fresh: false,
        reason: "candidate-entries-predate-last-persisted",
        lastPersistedAt: lastPersisted.createdAt,
        firstCandidateAt,
      };
    }

    // Identity overlap against recent persisted history. Only
    // lineage-DISCRIMINATING content participates: synthetic heartbeat
    // traffic and content that recurs within the window appear identically
    // in every session and prove nothing (live incident: a week-idle lane's
    // entire recent window was heartbeat polls, false-blocking the heal).
    // Empty stored content (pure tool rows) is likewise skipped.
    const collectDiscriminatingIdentities = async (window: number): Promise<Set<string>> => {
      const records = await this.conversationStore.getLastMessages(
        params.conversationId,
        window,
      );
      const counts = new Map<string, number>();
      for (const record of records) {
        if (
          record.content.trim().length === 0 ||
          isHeartbeatNoiseContent(record.role, record.content)
        ) {
          continue;
        }
        const identity = messageIdentity(record.role, record.content);
        counts.set(identity, (counts.get(identity) ?? 0) + 1);
      }
      const identities = new Set<string>();
      for (const [identity, count] of counts) {
        if (count === 1) {
          identities.add(identity);
        }
      }
      return identities;
    };
    let persistedIdentities = await collectDiscriminatingIdentities(
      AMBIGUOUS_ROLLOVER_OVERLAP_WINDOW,
    );
    if (persistedIdentities.size === 0) {
      persistedIdentities = await collectDiscriminatingIdentities(
        AMBIGUOUS_ROLLOVER_OVERLAP_WIDE_WINDOW,
      );
    }
    if (persistedIdentities.size === 0) {
      // Even the widened window holds nothing but template noise: the
      // overlap test has no signal in either direction. The per-entry time
      // gate above already proved every new entry postdates the last
      // persisted message — a transcript wholly created after persistence
      // stopped cannot be a lost continuation of stored content. A wrongful
      // rotation only archives (fully reversible, still queryable) while
      // staying frozen silently loses data, so proceed on time evidence.
      return {
        fresh: true,
        reason: "fresh-time-evidence-only-no-comparable-history",
        lastPersistedAt: lastPersisted.createdAt,
        firstCandidateAt,
      };
    }
    let checkedCandidateIdentity = false;
    let bypassedTrivialDeliberateOverlap = false;
    for (const message of params.candidateMessages) {
      const stored = toStoredMessage(message);
      if (
        stored.content.trim().length === 0 ||
        isHeartbeatNoiseContent(stored.role, stored.content)
      ) {
        continue;
      }
      checkedCandidateIdentity = true;
      if (persistedIdentities.has(messageIdentity(stored.role, stored.content))) {
        // A deliberate /new (marker + archive sibling) plus trivial
        // overlapping content is the rapid-rollover health-check shape
        // (e.g. a lone "ping" repeated across sessions) — not evidence of a
        // foreign transcript reusing the key. Substantial overlapping
        // content still fails closed even here: see
        // TRIVIAL_ROLLOVER_OVERLAP_CONTENT_MAX_LENGTH's docstring.
        if (params.hasDeliberateRolloverEvidence && isTrivialRolloverOverlapContent(stored.content)) {
          bypassedTrivialDeliberateOverlap = true;
          continue;
        }
        return {
          fresh: false,
          reason: "identity-overlap-with-persisted-history",
          lastPersistedAt: lastPersisted.createdAt,
          firstCandidateAt,
        };
      }
    }
    if (!checkedCandidateIdentity) {
      return {
        fresh: false,
        reason: "no-comparable-candidate-content",
        lastPersistedAt: lastPersisted.createdAt,
        firstCandidateAt,
      };
    }

    return {
      fresh: true,
      reason: bypassedTrivialDeliberateOverlap
        ? "fresh-trivial-identity-overlap-deliberate-rollover"
        : "fresh",
      lastPersistedAt: lastPersisted.createdAt,
      firstCandidateAt,
    };
  }

  /**
   * Tier-2 resolution for ambiguous session-key runtime rollovers
   * (lossless-claw-30b.8): a provably fresh new transcript means the
   * rollover is a legitimate runtime session-file reset, not a foreign
   * transcript sharing the key. Rebind the existing conversation row so all
   * summaries, messages, frontier rows, and metadata keep the same
   * conversation id while the new session can bootstrap normally. Returns the
   * rebind outcome plus whether a non-rebound preserve is an expected pending
   * state rather than a genuine freeze.
   */
  async rotateAmbiguousRolloverForProvablyFreshTranscript(params: {
    phase: "bootstrap" | "assemble" | "afterTurn";
    sessionId: string;
    rollover: AmbiguousSessionKeyRuntimeRollover;
    candidateMessages: AgentMessage[];
    createReplacement: boolean;
  }): Promise<AmbiguousRolloverResolution> {
    let verdict: Awaited<ReturnType<SessionRolloverDetector["evaluateAmbiguousRolloverFreshness"]>>;
    try {
      verdict = await this.evaluateAmbiguousRolloverFreshness({
        conversationId: params.rollover.conversationId,
        candidateMessages: params.candidateMessages,
        hasDeliberateRolloverEvidence: params.rollover.hasDeliberateRolloverEvidence,
      });
    } catch (err) {
      this.deps.log.warn(
        `[lcm] ${params.phase}: ambiguous rollover freshness check failed conversation=${params.rollover.conversationId} error=${describeLogError(err)}`,
      );
      return { rebound: false, preserveExpected: false, alreadyWarned: false };
    }
    if (!verdict.fresh) {
      const preserveExpected = isTransientAmbiguousRolloverFreshness(verdict.reason);
      const message = `[lcm] ${params.phase}: ambiguous rollover not provably fresh conversation=${params.rollover.conversationId} sessionKey=${params.rollover.sessionKey} freshness=${verdict.reason} lastPersistedAt=${verdict.lastPersistedAt?.toISOString() ?? "none"} firstCandidateAt=${verdict.firstCandidateAt !== null ? new Date(verdict.firstCandidateAt).toISOString() : "none"}`;
      if (preserveExpected) {
        this.deps.log.info(message);
        return { rebound: false, preserveExpected, alreadyWarned: false };
      }
      // Once-only WARN: a genuine freeze re-derives identically on every
      // subsequent call (nothing about a failed attempt mutates state), so
      // only the first occurrence of a given (generation, reason) pair
      // warns; repeats log at debug. A reason change for the same
      // generation is a materially different situation and warns again.
      const generationKey = this.ambiguousRolloverGenerationKey(params.rollover, params.sessionId);
      const alreadyWarned = this.warnedAmbiguousRolloverGenerations.get(generationKey) === verdict.reason;
      if (alreadyWarned) {
        this.deps.log.debug(message);
      } else {
        this.deps.log.warn(message);
        if (
          !this.warnedAmbiguousRolloverGenerations.has(generationKey)
          && this.warnedAmbiguousRolloverGenerations.size
            >= SessionRolloverDetector.WARNED_AMBIGUOUS_ROLLOVER_GENERATIONS_CAP
        ) {
          const oldest = this.warnedAmbiguousRolloverGenerations.keys().next().value;
          if (typeof oldest === "string") {
            this.warnedAmbiguousRolloverGenerations.delete(oldest);
          }
        }
        this.warnedAmbiguousRolloverGenerations.set(generationKey, verdict.reason);
      }
      return { rebound: false, preserveExpected, alreadyWarned };
    }

    const rebound = await this.conversationStore.rebindConversationSession(
      params.rollover.conversationId,
      params.sessionId,
      params.rollover.sessionKey,
    );
    if (!rebound || rebound.sessionId !== params.sessionId || !rebound.active) {
      this.deps.log.warn(
        `[lcm] ${params.phase}: ambiguous rollover rebind failed conversation=${params.rollover.conversationId} sessionKey=${params.rollover.sessionKey} oldSessionId=${params.rollover.activeSessionId} newSessionId=${params.sessionId}; leaving lane frozen`,
      );
      return { rebound: false, preserveExpected: false, alreadyWarned: false };
    }

    // Expected success: the lane healed in place. Logged at info so the
    // recovery is observable without flagging a routine /new as an anomaly.
    this.deps.log.info(
      `[lcm] ${params.phase}: ambiguous rollover resolved by fresh-transcript rebind conversation=${params.rollover.conversationId} sessionKey=${params.rollover.sessionKey} oldSessionId=${params.rollover.activeSessionId} newSessionId=${params.sessionId} candidateMessages=${params.candidateMessages.length} lastPersistedAt=${verdict.lastPersistedAt?.toISOString() ?? "none"} firstCandidateAt=${verdict.firstCandidateAt !== null ? new Date(verdict.firstCandidateAt).toISOString() : "none"}`,
    );
    return { rebound: true };
  }

  /**
   * Check whether a candidate runtime transcript is fresh enough to rotate an
   * isolated cron lane without risking an older callback taking over the active
   * cron conversation.
   */
  async transcriptIsProvablyFreshForRuntimeRollover(params: {
    phase: "bootstrap" | "assemble" | "afterTurn";
    conversationId: number;
    sessionKey: string;
    activeSessionId: string;
    nextSessionId: string;
    candidateMessages: AgentMessage[];
    source: "isolated-cron";
  }): Promise<boolean> {
    let verdict: Awaited<ReturnType<SessionRolloverDetector["evaluateAmbiguousRolloverFreshness"]>>;
    try {
      verdict = await this.evaluateAmbiguousRolloverFreshness({
        conversationId: params.conversationId,
        candidateMessages: params.candidateMessages,
      });
    } catch (err) {
      this.deps.log.warn(
        `[lcm] ${params.phase}: ${params.source} freshness check failed conversation=${params.conversationId} error=${describeLogError(err)}`,
      );
      return false;
    }

    if (!verdict.fresh) {
      const message = `[lcm] ${params.phase}: ${params.source} rollover not provably fresh conversation=${params.conversationId} sessionKey=${params.sessionKey} oldSessionId=${params.activeSessionId} newSessionId=${params.nextSessionId} freshness=${verdict.reason} lastPersistedAt=${verdict.lastPersistedAt?.toISOString() ?? "none"} firstCandidateAt=${verdict.firstCandidateAt !== null ? new Date(verdict.firstCandidateAt).toISOString() : "none"}`;
      if (isTransientAmbiguousRolloverFreshness(verdict.reason)) {
        this.deps.log.info(message);
      } else {
        this.deps.log.warn(message);
      }
      return false;
    }

    this.deps.log.info(
      `[lcm] ${params.phase}: ${params.source} rollover transcript proved fresh conversation=${params.conversationId} sessionKey=${params.sessionKey} oldSessionId=${params.activeSessionId} newSessionId=${params.nextSessionId} candidateMessages=${params.candidateMessages.length} lastPersistedAt=${verdict.lastPersistedAt?.toISOString() ?? "none"} firstCandidateAt=${verdict.firstCandidateAt !== null ? new Date(verdict.firstCandidateAt).toISOString() : "none"}`,
    );
    return true;
  }

  async transcriptContainsCurrentConversationTailAnchor(params: {
    conversationId: number;
    historicalMessages: AgentMessage[];
    checkpointEntryHash?: string | null;
  }): Promise<boolean> {
    if (params.historicalMessages.length === 0) {
      return false;
    }

    const persistedMessages = await this.conversationStore.getMessages(params.conversationId);
    if (persistedMessages.length < 2 || !params.checkpointEntryHash) {
      return false;
    }

    const storedHistoricalMessages = params.historicalMessages.map((message) =>
      toStoredMessage(message),
    );
    const tailLength = Math.min(3, persistedMessages.length);
    const persistedTail = persistedMessages.slice(-tailLength);
    for (let index = tailLength - 1; index < storedHistoricalMessages.length; index += 1) {
      if (
        createBootstrapEntryHash(storedHistoricalMessages[index]!) !==
        params.checkpointEntryHash
      ) {
        continue;
      }
      const historicalTail = storedHistoricalMessages.slice(index - tailLength + 1, index + 1);
      // A single common tail like "Done" is not enough to bind a new runtime to
      // an existing keyed conversation. Require a contiguous persisted suffix.
      const tailsMatch = persistedTail.every((persistedMessage, tailIndex) => {
        const historical = historicalTail[tailIndex];
        return (
          historical !== undefined &&
          messageIdentity(persistedMessage.role, persistedMessage.content) ===
            messageIdentity(historical.role, historical.content)
        );
      });
      if (tailsMatch) {
        return true;
      }
    }

    return false;
  }
}

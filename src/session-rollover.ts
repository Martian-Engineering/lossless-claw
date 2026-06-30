/**
 * Session rollover detection: recovers lifecycle splits the host missed —
 * stable session keys whose tracked transcript file disappeared, isolated
 * cron lanes whose runtime UUID changed, and ambiguous session-key runtime
 * rollovers that need a freshness check before rotating the conversation.
 *
 * Extracted from engine.ts (Phase 3 of the engine decomposition).
 */
import { stat } from "node:fs/promises";
import { isHeartbeatNoiseContent } from "./heartbeat-filter.js";
import { describeLogError } from "./lcm-log.js";
import { isLikelyInjectedDeliveryOnlyTranscript, toStoredMessage } from "./message-content.js";
import { createBootstrapEntryHash, messageIdentity } from "./message-signatures.js";
import type { AgentMessage } from "./openclaw-bridge.js";
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

export type AmbiguousSessionKeyRuntimeRollover = {
  conversationId: number;
  activeSessionId: string;
  sessionKey: string;
  trackedSessionFile: string;
};

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
  constructor(
    private readonly conversationStore: ConversationStore,
    private readonly summaryStore: SummaryStore,
    private readonly deps: Pick<LcmDependencies, "log">,
    private readonly applySessionReplacement: ApplySessionReplacementFn,
  ) {}

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

  /** Cron session keys represent isolated scheduled runs, not conversation continuity. */
  private isIsolatedCronSessionKey(sessionKey?: string): boolean {
    const trimmed = sessionKey?.trim();
    if (!trimmed) {
      return false;
    }
    const parts = trimmed.split(":");
    return parts.length >= 4 && parts[0] === "agent" && parts[2] === "cron";
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
      !this.isIsolatedCronSessionKey(normalizedSessionKey)
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

    try {
      await stat(trackedSessionFile);
    } catch (err) {
      if (!isMissingFileError(err)) {
        this.deps.log.warn(
          `[lcm] ${params.phase}: could not verify tracked transcript path for ambiguous runtime rollover guard conversation=${activeByKey.conversationId} file=${trackedSessionFile} error=${describeLogError(err)}`,
        );
      }
      return null;
    }

    return {
      conversationId: activeByKey.conversationId,
      activeSessionId: activeByKey.sessionId,
      sessionKey: normalizedSessionKey,
      trackedSessionFile,
    };
  }

  logAmbiguousSessionKeyRuntimeRollover(params: {
    phase: "bootstrap" | "assemble" | "afterTurn";
    rollover: AmbiguousSessionKeyRuntimeRollover;
    sessionId: string;
    sessionFile?: string;
  }): void {
    this.deps.log.warn(
      `[lcm] ${params.phase}: ${AMBIGUOUS_SESSION_KEY_RUNTIME_ROLLOVER_REASON}; preserving conversation=${params.rollover.conversationId} session=${params.sessionId} sessionKey=${params.rollover.sessionKey} oldSessionId=${params.rollover.activeSessionId} oldFile=${params.rollover.trackedSessionFile}${params.sessionFile ? ` newFile=${params.sessionFile}` : ""}`,
    );
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

    return { fresh: true, reason: "fresh", lastPersistedAt: lastPersisted.createdAt, firstCandidateAt };
  }

  /**
   * Tier-2 resolution for ambiguous session-key runtime rollovers
   * (lossless-claw-30b.8): a provably fresh new transcript means the
   * rollover is a legitimate runtime session-file reset, not a foreign
   * transcript sharing the key. Rebind the existing conversation row so all
   * summaries, messages, frontier rows, and metadata keep the same
   * conversation id while the new session can bootstrap normally. Returns
   * true when rebound; false leaves the existing freeze-and-preserve
   * behavior in place.
   */
  async rotateAmbiguousRolloverForProvablyFreshTranscript(params: {
    phase: "bootstrap" | "assemble" | "afterTurn";
    sessionId: string;
    rollover: AmbiguousSessionKeyRuntimeRollover;
    candidateMessages: AgentMessage[];
    createReplacement: boolean;
  }): Promise<boolean> {
    let verdict: Awaited<ReturnType<SessionRolloverDetector["evaluateAmbiguousRolloverFreshness"]>>;
    try {
      verdict = await this.evaluateAmbiguousRolloverFreshness({
        conversationId: params.rollover.conversationId,
        candidateMessages: params.candidateMessages,
      });
    } catch (err) {
      this.deps.log.warn(
        `[lcm] ${params.phase}: ambiguous rollover freshness check failed conversation=${params.rollover.conversationId} error=${describeLogError(err)}`,
      );
      return false;
    }
    if (!verdict.fresh) {
      this.deps.log.warn(
        `[lcm] ${params.phase}: ambiguous rollover not provably fresh conversation=${params.rollover.conversationId} sessionKey=${params.rollover.sessionKey} freshness=${verdict.reason} lastPersistedAt=${verdict.lastPersistedAt?.toISOString() ?? "none"} firstCandidateAt=${verdict.firstCandidateAt !== null ? new Date(verdict.firstCandidateAt).toISOString() : "none"}`,
      );
      return false;
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
      return false;
    }

    this.deps.log.warn(
      `[lcm] ${params.phase}: ambiguous rollover resolved by fresh-transcript rebind conversation=${params.rollover.conversationId} sessionKey=${params.rollover.sessionKey} oldSessionId=${params.rollover.activeSessionId} newSessionId=${params.sessionId} candidateMessages=${params.candidateMessages.length} lastPersistedAt=${verdict.lastPersistedAt?.toISOString() ?? "none"} firstCandidateAt=${verdict.firstCandidateAt !== null ? new Date(verdict.firstCandidateAt).toISOString() : "none"}`,
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

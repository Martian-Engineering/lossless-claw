/**
 * Host-bound disclosure capability (proposed seam, optional).
 *
 * A host that serves more than one authenticated person or audience through a
 * single LCM database can hand each tool invocation (and each assemble() call)
 * a capability object. The capability keeps two identities apart:
 *
 * - `requesterId`: the authenticated person on whose behalf the call runs.
 * - `audienceId`: the destination the result will be released to (a DM, a
 *   room, a child session that relays to one of those).
 *
 * LosslessClaw never derives either from tool parameters, session display
 * names, session-key shapes, or content IDs. It only asks the capability
 * whether a conversation may be disclosed, live, every time it is about to
 * release something and again right before it hands a result back.
 *
 * Contract status: this is a plugin-side proposal. No OpenClaw release is
 * known to emit it, so when a call carries no capability behavior is unchanged
 * (unrestricted, as before). When a capability IS present but malformed, or its
 * decision throws or is not an explicit `true`, access is denied.
 *
 * Ownership: the host/Knowledge side owns grants and membership. This module
 * stores nothing and keeps no grant table. LosslessClaw stays the owner of
 * conversation history and context assembly.
 */
import type { LcmContextEngine } from "./engine.js";

/** What the host is asked about. Derived from the stored conversation row only. */
export type LcmDisclosureTarget = Readonly<{
  conversationId: number;
  sessionKey: string | null;
  sessionId: string | null;
  active: boolean;
}>;

/** Host-issued, invocation-bound capability. */
export type LcmDisclosureCapability = {
  version: 1;
  /** Authenticated requester (opaque to LCM). Required. */
  requesterId: string;
  /** Destination audience the result is released to (opaque to LCM). Required. */
  audienceId: string;
  /**
   * Live decision, evaluated at every disclosure and again at release. Must
   * return one boolean per target, in order. Anything other than `true`
   * denies.
   */
  authorizeConversations(
    targets: readonly LcmDisclosureTarget[],
  ): readonly boolean[] | Promise<readonly boolean[]>;
};

/** Uniform text for every denied or nonexistent conversation target. */
export const DISCLOSURE_CONVERSATION_UNAVAILABLE =
  "The requested LCM conversation is not available in this session scope.";

/** Uniform text for every denied or nonexistent summary/file target. */
export const DISCLOSURE_ITEM_UNAVAILABLE = "Not found in this session scope.";

/** Text returned when authority changed while a result was being produced. */
export const DISCLOSURE_RESULT_WITHHELD =
  "Result withheld: disclosure authority changed while the request was running.";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isCapability(value: unknown): value is LcmDisclosureCapability {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<LcmDisclosureCapability>;
  return (
    candidate.version === 1
    && isNonEmptyString(candidate.requesterId)
    && isNonEmptyString(candidate.audienceId)
    && typeof candidate.authorizeConversations === "function"
  );
}

/** Gate over one capability. Holds no state beyond the capability reference. */
export class LcmDisclosureGate {
  constructor(private readonly capability: LcmDisclosureCapability | null) {}

  /** True when the host supplied something unusable; every decision denies. */
  get denyAll(): boolean {
    return this.capability === null;
  }

  get requesterId(): string | undefined {
    return this.capability?.requesterId;
  }

  get audienceId(): string | undefined {
    return this.capability?.audienceId;
  }

  /** Authorize conversation IDs live. Unknown IDs are denied like forbidden ones. */
  async authorizeConversationIds(
    lcm: Pick<LcmContextEngine, "getConversationStore">,
    conversationIds: readonly number[],
  ): Promise<Set<number>> {
    const allowed = new Set<number>();
    const capability = this.capability;
    if (!capability) {
      return allowed;
    }
    const unique = Array.from(
      new Set(conversationIds.filter((id) => Number.isInteger(id))),
    );
    if (unique.length === 0) {
      return allowed;
    }
    const store = lcm.getConversationStore();
    const targets: LcmDisclosureTarget[] = [];
    for (const conversationId of unique) {
      const record = await store.getConversation(conversationId);
      if (!record) {
        continue;
      }
      targets.push({
        conversationId: record.conversationId,
        sessionKey: record.sessionKey ?? null,
        sessionId: record.sessionId ?? null,
        active: record.active,
      });
    }
    if (targets.length === 0) {
      return allowed;
    }
    let decisions: readonly boolean[];
    try {
      decisions = await capability.authorizeConversations(targets);
    } catch {
      return allowed;
    }
    if (!Array.isArray(decisions) || decisions.length !== targets.length) {
      return allowed;
    }
    targets.forEach((target, index) => {
      if (decisions[index] === true) {
        allowed.add(target.conversationId);
      }
    });
    return allowed;
  }

  /** Every conversation the capability currently allows. */
  async listAuthorizedConversationIds(
    lcm: Pick<LcmContextEngine, "getConversationStore">,
  ): Promise<number[]> {
    if (!this.capability) {
      return [];
    }
    const all = await lcm.getConversationStore().listConversationIds();
    const allowed = await this.authorizeConversationIds(lcm, all);
    return all.filter((id) => allowed.has(id));
  }

  /** Re-check at release: true only when every ID is still authorized. */
  async confirm(
    lcm: Pick<LcmContextEngine, "getConversationStore">,
    conversationIds: Iterable<number>,
  ): Promise<boolean> {
    const ids = Array.from(new Set(conversationIds));
    if (ids.length === 0) {
      return true;
    }
    const allowed = await this.authorizeConversationIds(lcm, ids);
    return ids.every((id) => allowed.has(id));
  }
}

/**
 * Turn the untrusted host-supplied value into a gate.
 *
 * - `undefined`/`null`: no capability; returns `null` (behavior unchanged).
 * - valid capability: a live gate.
 * - anything else: a deny-all gate, never an open one.
 */
export function createDisclosureGate(raw: unknown): LcmDisclosureGate | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  return new LcmDisclosureGate(isCapability(raw) ? raw : null);
}

/** Collects every conversation ID a request is about to disclose from. */
export type ReleaseTracker = {
  track(conversationIds: Iterable<number | null | undefined>): void;
};

/**
 * Run a tool body, then re-check live authority over everything it tracked
 * before the result leaves. A revoked or changed audience gets a withheld
 * marker instead of the result.
 */
export async function runWithReleaseRecheck<T>(input: {
  gate: LcmDisclosureGate | null;
  lcm: Pick<LcmContextEngine, "getConversationStore">;
  run: (tracker: ReleaseTracker) => Promise<T>;
  withheld: (message: string) => T;
}): Promise<T> {
  const tracked = new Set<number>();
  const tracker: ReleaseTracker = {
    track(conversationIds) {
      for (const id of conversationIds) {
        if (typeof id === "number" && Number.isInteger(id)) {
          tracked.add(id);
        }
      }
    },
  };
  const result = await input.run(tracker);
  if (!input.gate || tracked.size === 0) {
    return result;
  }
  const stillAllowed = await input.gate.confirm(input.lcm, tracked);
  return stillAllowed ? result : input.withheld(DISCLOSURE_RESULT_WITHHELD);
}

import type { MessageId, MessageRole, TranscriptAnchorTrustState } from "./store/conversation-store.js";

export type TranscriptAnchorAuditClassification =
  | "verified"
  | "repairable"
  | "legacy_prefix"
  | "corrupt";

export type TranscriptAnchorAuditMessage = {
  messageId: MessageId;
  seq: number;
  role: MessageRole;
  content: string;
  transcriptEntryId: string | null;
  anchorTrustState?: TranscriptAnchorTrustState | null;
  createdAt?: Date | string;
};

export type TranscriptAnchorAuditEntry = {
  entryId: string;
  parentId: string | null;
  seq: number;
  role: MessageRole;
  content: string;
  createdAt?: Date | string;
};

export type TranscriptAnchorDecision = {
  messageId: MessageId;
  transcriptEntryId: string;
  trustState: Extract<TranscriptAnchorTrustState, "verified" | "suspect">;
  reason: string;
};

export type TranscriptAnchorRepairProposal = {
  messageId: MessageId;
  transcriptEntryId: string;
  reason: string;
};

export type TranscriptAnchorAuditResult = {
  classification: TranscriptAnchorAuditClassification;
  anchorDecisions: TranscriptAnchorDecision[];
  repairProposals: TranscriptAnchorRepairProposal[];
  requiresEpochBoundary: boolean;
};

type SequenceAlignment = {
  aligned: boolean;
  uniqueNonEmpty: boolean;
};

function identityKey(role: MessageRole, content: string): string {
  return `${role}\0${content}`;
}

function hasDuplicate(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function classifyStampedAnchor(
  message: TranscriptAnchorAuditMessage,
  entry: TranscriptAnchorAuditEntry | undefined,
): TranscriptAnchorDecision | null {
  const transcriptEntryId = message.transcriptEntryId;
  if (!transcriptEntryId) {
    return null;
  }
  if (!entry) {
    return {
      messageId: message.messageId,
      transcriptEntryId,
      trustState: "suspect",
      reason: "entry id missing from projection",
    };
  }
  if (entry.role !== message.role) {
    return {
      messageId: message.messageId,
      transcriptEntryId,
      trustState: "suspect",
      reason: "entry id role mismatch",
    };
  }
  if (entry.content !== message.content) {
    return {
      messageId: message.messageId,
      transcriptEntryId,
      trustState: "suspect",
      reason: "entry id content mismatch",
    };
  }
  const hasExplicitTrust =
    message.anchorTrustState === "verified" || message.anchorTrustState === "repaired";
  if (!hasExplicitTrust && message.content.trim() === "") {
    return {
      messageId: message.messageId,
      transcriptEntryId,
      trustState: "suspect",
      reason: "blank content cannot prove entry id",
    };
  }
  if (!hasExplicitTrust) {
    return {
      messageId: message.messageId,
      transcriptEntryId,
      trustState: "suspect",
      reason: "entry id lacks explicit trust",
    };
  }
  return {
    messageId: message.messageId,
    transcriptEntryId,
    trustState: "verified",
    reason: "entry id matches role and content",
  };
}

function inspectSequenceAlignment(params: {
  messages: readonly TranscriptAnchorAuditMessage[];
  entries: readonly TranscriptAnchorAuditEntry[];
}): SequenceAlignment {
  const { messages, entries } = params;
  if (messages.length === 0 || messages.length > entries.length) {
    return { aligned: false, uniqueNonEmpty: false };
  }

  const keys: string[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    const entry = entries[index]!;
    if (message.role !== entry.role || message.content !== entry.content) {
      return { aligned: false, uniqueNonEmpty: false };
    }
    if (message.content.trim() === "") {
      return { aligned: true, uniqueNonEmpty: false };
    }
    keys.push(identityKey(message.role, message.content));
  }

  return { aligned: true, uniqueNonEmpty: !hasDuplicate(keys) };
}

function buildRepairProposals(params: {
  messages: readonly TranscriptAnchorAuditMessage[];
  entries: readonly TranscriptAnchorAuditEntry[];
  alignment: SequenceAlignment;
}): TranscriptAnchorRepairProposal[] {
  const { messages, entries, alignment } = params;
  if (!alignment.aligned || !alignment.uniqueNonEmpty) {
    return [];
  }

  const repairs: TranscriptAnchorRepairProposal[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.transcriptEntryId) {
      continue;
    }
    repairs.push({
      messageId: message.messageId,
      transcriptEntryId: entries[index]!.entryId,
      reason: "unique non-empty sequence alignment",
    });
  }
  return repairs;
}

/**
 * Classify whether existing LCM transcript entry ids are safe anchors.
 *
 * This function is intentionally pure. It never repairs data by itself; callers
 * must persist explicit trust rows or epoch boundaries based on the result.
 */
export function classifyTranscriptAnchors(params: {
  messages: readonly TranscriptAnchorAuditMessage[];
  entries: readonly TranscriptAnchorAuditEntry[];
}): TranscriptAnchorAuditResult {
  const entriesById = new Map(params.entries.map((entry) => [entry.entryId, entry]));
  const anchorDecisions: TranscriptAnchorDecision[] = [];

  // First classify ids that already exist in LCM. A populated id column is only
  // a candidate; it becomes trustworthy only when the source entry matches.
  for (const message of params.messages) {
    const decision = classifyStampedAnchor(
      message,
      message.transcriptEntryId ? entriesById.get(message.transcriptEntryId) : undefined,
    );
    if (decision) {
      anchorDecisions.push(decision);
    }
  }

  const hasSuspectAnchor = anchorDecisions.some((decision) => decision.trustState === "suspect");
  if (hasSuspectAnchor) {
    return {
      classification: "legacy_prefix",
      anchorDecisions,
      repairProposals: [],
      requiresEpochBoundary: true,
    };
  }

  const allMessagesStamped =
    params.messages.length > 0 && params.messages.every((message) => message.transcriptEntryId);
  if (allMessagesStamped) {
    return {
      classification: "verified",
      anchorDecisions,
      repairProposals: [],
      requiresEpochBoundary: false,
    };
  }

  const alignment = inspectSequenceAlignment(params);
  const repairProposals = buildRepairProposals({
    messages: params.messages,
    entries: params.entries,
    alignment,
  });
  if (repairProposals.length > 0) {
    return {
      classification: "repairable",
      anchorDecisions,
      repairProposals,
      requiresEpochBoundary: false,
    };
  }

  return {
    classification: params.messages.length === 0 ? "verified" : "legacy_prefix",
    anchorDecisions,
    repairProposals: [],
    requiresEpochBoundary: params.messages.length > 0,
  };
}

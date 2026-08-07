import type { SummaryKind } from "./summary-store.js";

export type PendingCompactionBatchStatus =
  | "planning"
  | "ready"
  | "publishing"
  | "published"
  | "stale"
  | "failed";

export type PendingSummaryNodeStatus =
  | "planned"
  | "running"
  | "ready"
  | "promoted"
  | "stale"
  | "failed";

export type PendingCompactionBatchRecord = {
  batchId: string;
  conversationId: number;
  sessionKey: string | null;
  sessionTargetJson: string;
  status: PendingCompactionBatchStatus;
  sourceProjectionFingerprint: string;
  compactableStartOrdinal: number;
  compactableEndOrdinal: number;
  plannedFreshTailStartOrdinal: number | null;
  promptVersion: string;
  model: string;
  failureSummary: string | null;
  createdAt: Date;
  updatedAt: Date;
  publishedAt: Date | null;
};

export type CreatePendingCompactionBatchInput = {
  batchId: string;
  conversationId: number;
  sessionKey?: string | null;
  sessionTargetJson?: string;
  status?: PendingCompactionBatchStatus;
  sourceProjectionFingerprint: string;
  compactableStartOrdinal: number;
  compactableEndOrdinal: number;
  plannedFreshTailStartOrdinal?: number | null;
  promptVersion: string;
  model: string;
};

export type PendingSummaryNodeRecord = {
  nodeId: string;
  batchId: string;
  conversationId: number;
  kind: SummaryKind;
  depth: number;
  status: PendingSummaryNodeStatus;
  ordinalStart: number;
  ordinalEnd: number;
  sourceFingerprint: string;
  sourceContextHash: string | null;
  content: string | null;
  tokenCount: number | null;
  promptVersion: string;
  model: string;
  canonicalSummaryId: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  failureSummary: string | null;
  retryCount: number;
  nextAttemptAfter: Date | null;
  createdAt: Date;
  updatedAt: Date;
  readyAt: Date | null;
  promotedAt: Date | null;
};

export type InsertPendingSummaryNodeInput = {
  nodeId: string;
  batchId: string;
  conversationId: number;
  kind: SummaryKind;
  depth: number;
  status?: PendingSummaryNodeStatus;
  ordinalStart: number;
  ordinalEnd: number;
  sourceFingerprint: string;
  sourceContextHash?: string | null;
  content?: string | null;
  tokenCount?: number | null;
  promptVersion: string;
  model: string;
};

export type PendingSummaryNodeMessageInput = {
  messageId: number;
  transcriptEntryId?: string | null;
  identityHash?: string | null;
};

export type PendingSummaryNodeMessageRecord = {
  messageId: number;
  transcriptEntryId: string | null;
  identityHash: string | null;
};

export type PendingSummaryNodeChildInput = {
  childNodeId?: string | null;
  childSummaryId?: string | null;
};

export type PendingSummaryNodeChildRecord = {
  childNodeId: string | null;
  childSummaryId: string | null;
};

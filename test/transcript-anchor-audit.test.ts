import { describe, expect, it } from "vitest";
import {
  classifyTranscriptAnchors,
  type TranscriptAnchorAuditEntry,
  type TranscriptAnchorAuditMessage,
} from "../src/transcript-anchor-audit.js";

function message(input: Partial<TranscriptAnchorAuditMessage>): TranscriptAnchorAuditMessage {
  return {
    messageId: input.messageId ?? 1,
    seq: input.seq ?? 1,
    role: input.role ?? "user",
    content: input.content ?? "hello",
    transcriptEntryId: input.transcriptEntryId ?? null,
    anchorTrustState: input.anchorTrustState,
    createdAt: input.createdAt,
  };
}

function entry(input: Partial<TranscriptAnchorAuditEntry>): TranscriptAnchorAuditEntry {
  return {
    entryId: input.entryId ?? "entry-1",
    parentId: input.parentId ?? null,
    seq: input.seq ?? 1,
    role: input.role ?? "user",
    content: input.content ?? "hello",
    createdAt: input.createdAt,
  };
}

describe("classifyTranscriptAnchors", () => {
  it("verifies existing ids only when the OpenClaw entry matches role and content", () => {
    const result = classifyTranscriptAnchors({
      messages: [
        message({
          messageId: 1,
          seq: 1,
          role: "user",
          content: "hello",
          transcriptEntryId: "entry-user",
          anchorTrustState: "verified",
        }),
        message({
          messageId: 2,
          seq: 2,
          role: "assistant",
          content: "reply",
          transcriptEntryId: "entry-assistant",
          anchorTrustState: "repaired",
        }),
      ],
      entries: [
        entry({ entryId: "entry-user", seq: 1, role: "user", content: "hello" }),
        entry({ entryId: "entry-assistant", seq: 2, role: "assistant", content: "reply" }),
      ],
    });

    expect(result.classification).toBe("verified");
    expect(result.anchorDecisions).toEqual([
      {
        messageId: 1,
        transcriptEntryId: "entry-user",
        trustState: "verified",
        reason: "entry id matches role and content",
      },
      {
        messageId: 2,
        transcriptEntryId: "entry-assistant",
        trustState: "verified",
        reason: "entry id matches role and content",
      },
    ]);
  });

  it("marks blank assistant ids suspect when they point at nonblank projection entries", () => {
    const result = classifyTranscriptAnchors({
      messages: [
        message({
          messageId: 10,
          seq: 1,
          role: "assistant",
          content: "",
          transcriptEntryId: "entry-current-assistant",
        }),
      ],
      entries: [
        entry({
          entryId: "entry-current-assistant",
          seq: 1,
          role: "assistant",
          content: "I saw the question you actually asked.",
        }),
      ],
    });

    expect(result.classification).toBe("legacy_prefix");
    expect(result.anchorDecisions).toEqual([
      {
        messageId: 10,
        transcriptEntryId: "entry-current-assistant",
        trustState: "suspect",
        reason: "entry id content mismatch",
      },
    ]);
    expect(result.requiresEpochBoundary).toBe(true);
  });

  it("marks blank stamped ids suspect even when the projection entry is also blank", () => {
    const result = classifyTranscriptAnchors({
      messages: [
        message({
          messageId: 11,
          seq: 1,
          role: "assistant",
          content: "",
          transcriptEntryId: "entry-blank",
        }),
      ],
      entries: [
        entry({
          entryId: "entry-blank",
          seq: 1,
          role: "assistant",
          content: "",
        }),
      ],
    });

    expect(result.classification).toBe("legacy_prefix");
    expect(result.anchorDecisions).toEqual([
      {
        messageId: 11,
        transcriptEntryId: "entry-blank",
        trustState: "suspect",
        reason: "blank content cannot prove entry id",
      },
    ]);
    expect(result.requiresEpochBoundary).toBe(true);
  });

  it("does not trust stamped non-empty ids without explicit trust state", () => {
    const result = classifyTranscriptAnchors({
      messages: [
        message({
          messageId: 12,
          seq: 1,
          role: "user",
          content: "same text",
          transcriptEntryId: "entry-same-text",
        }),
      ],
      entries: [
        entry({
          entryId: "entry-same-text",
          seq: 1,
          role: "user",
          content: "same text",
        }),
      ],
    });

    expect(result.classification).toBe("legacy_prefix");
    expect(result.anchorDecisions).toEqual([
      {
        messageId: 12,
        transcriptEntryId: "entry-same-text",
        trustState: "suspect",
        reason: "entry id lacks explicit trust",
      },
    ]);
    expect(result.requiresEpochBoundary).toBe(true);
  });

  it("does not repair repeated blank assistant rows from role and content alone", () => {
    const result = classifyTranscriptAnchors({
      messages: [
        message({ messageId: 1, seq: 1, role: "assistant", content: "" }),
        message({ messageId: 2, seq: 2, role: "assistant", content: "" }),
      ],
      entries: [
        entry({ entryId: "entry-a", seq: 1, role: "assistant", content: "" }),
        entry({ entryId: "entry-b", seq: 2, role: "assistant", content: "" }),
      ],
    });

    expect(result.classification).toBe("legacy_prefix");
    expect(result.anchorDecisions).toEqual([]);
    expect(result.repairProposals).toEqual([]);
    expect(result.requiresEpochBoundary).toBe(true);
  });

  it("proposes repairs for deterministic non-empty sequence alignment", () => {
    const result = classifyTranscriptAnchors({
      messages: [
        message({ messageId: 1, seq: 1, role: "user", content: "first" }),
        message({ messageId: 2, seq: 2, role: "assistant", content: "second" }),
      ],
      entries: [
        entry({ entryId: "entry-first", seq: 1, role: "user", content: "first" }),
        entry({ entryId: "entry-second", seq: 2, role: "assistant", content: "second" }),
      ],
    });

    expect(result.classification).toBe("repairable");
    expect(result.repairProposals).toEqual([
      {
        messageId: 1,
        transcriptEntryId: "entry-first",
        reason: "unique non-empty sequence alignment",
      },
      {
        messageId: 2,
        transcriptEntryId: "entry-second",
        reason: "unique non-empty sequence alignment",
      },
    ]);
    expect(result.requiresEpochBoundary).toBe(false);
  });
});

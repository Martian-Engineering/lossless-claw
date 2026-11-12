import { describe, it, expect } from "vitest";
import { NativeDatabase } from "../src/storage/turbopuffer-native/database.js";
import { NativeConversationStore } from "../src/storage/turbopuffer-native/conversations.js";
import { NativeSummaryStore } from "../src/storage/turbopuffer-native/summaries.js";
import { NativePendingSummaryStore } from "../src/storage/turbopuffer-native/pending.js";
import { NativeCompactionMaintenanceStore } from "../src/storage/turbopuffer-native/maintenance.js";
import { NativeFocusBriefStore } from "../src/storage/turbopuffer-native/focus.js";
import {
  NativeTranscriptCursorStore,
  NativeTranscriptGapStore,
  NativeUserReplayKeyStore,
} from "../src/storage/turbopuffer-native/transcripts.js";
import { MemoryIo } from "./helpers/turbopuffer-native-io.js";
import { ContextAssembler } from "../src/assembler.js";
import { CompactionEngine } from "../src/compaction.js";
async function setup() {
  const io = new MemoryIo(),
    db = await NativeDatabase.open({
      organizationId: "org1",
      agentId: "alice",
      namespacePrefix: "native-store-test",
      io,
    });
  return {
    io,
    db,
    c: new NativeConversationStore(db),
    s: new NativeSummaryStore(db),
    p: new NativePendingSummaryStore(db),
  };
}
async function fixture(count = 32) {
  const f = await setup(),
    conversation = await f.c.createConversation({
      sessionId: "s",
      sessionKey: "agent:alice:first",
    });
  const messages = await f.c.createMessagesBulk(
    Array.from({ length: count }, (_, i) => ({
      conversationId: conversation.conversationId,
      seq: i + 1,
      role: i % 2 ? ("assistant" as const) : ("user" as const),
      content: `quartz message ${i}`,
      tokenCount: 100,
      transcriptEntryId: `entry-${i}`,
      createdAt: new Date(1700000000000 + i * 1000),
    }))
  );
  await f.s.appendContextMessages(
    conversation.conversationId,
    messages.map((r) => r.messageId)
  );
  return { ...f, cid: conversation.conversationId, messages };
}
describe("native LCM repositories", () => {
  it("keeps agents separate while retaining an agent own conversation family", async () => {
    const { c } = await setup();
    const first = await c.getOrCreateConversation("one", {
      sessionKey: "agent:alice:thread",
    });
    await c.archiveConversation(first.conversationId, "manual-reset");
    const second = await c.getOrCreateConversation("two", {
      sessionKey: "agent:alice:thread",
    });
    expect(
      await c.getConversationFamilyIds({ sessionKey: "agent:alice:thread" })
    ).toEqual([second.conversationId, first.conversationId]);
    await expect(
      c.createConversation({ sessionId: "bad", sessionKey: "agent:bob:thread" })
    ).rejects.toThrow("different native agent");
    expect((await c.getConversation(first.conversationId))?.active).toBe(false);
  });
  it("enforces append, transcript identity and lossless stable-key conflicts", async () => {
    const { c, cid, messages } = await fixture(4);
    await expect(
      c.createMessage({
        conversationId: cid,
        seq: 1,
        role: "user",
        content: "duplicate",
        tokenCount: 1,
      })
    ).rejects.toThrow("UNIQUE");
    await expect(
      c.createMessage({
        conversationId: cid,
        seq: 5,
        role: "user",
        content: "duplicate",
        tokenCount: 1,
        transcriptEntryId: "entry-0",
      })
    ).rejects.toThrow("UNIQUE");
    const input = {
      conversationId: cid,
      role: "assistant" as const,
      content: "new answer",
      tokenCount: 3,
      stableEventKey: "response-1",
    };
    await c.createMessage({ ...input, seq: 5 });
    await c.createMessage({ ...input, seq: 6 });
    expect(await c.getMessageCount(cid)).toBe(6);
    expect(
      await c.restampTranscriptEntryId(messages[0].messageId, "entry-1")
    ).toBe(false);
    expect(
      await c.restampTranscriptEntryId(messages[0].messageId, "new-entry")
    ).toBe(true);
    await c.upsertMessageTranscriptAnchorTrust({
      messageId: messages[0].messageId,
      conversationId: cid,
      transcriptEntryId: "new-entry",
      trustState: "verified",
      source: "host",
    });
    expect(await c.isTrustedTranscriptAnchor(cid, "new-entry")).toBe(true);
    expect((await c.getLastMessages(cid, 2)).map((r) => r.seq)).toEqual([5, 6]);
  });
  it("publishes summaries, source edges and sparse ordered context together; rolls failed graphs back", async () => {
    const { db, c, s, cid, messages } = await fixture();
    const before = await db.snapshot();
    await s.withTransaction(async () => {
      await s.insertSummary({
        summaryId: "leaf",
        conversationId: cid,
        kind: "leaf",
        content: "leaf quartz",
        tokenCount: 12,
      });
      await s.linkSummaryToMessages(
        "leaf",
        messages.slice(0, 8).map((r) => r.messageId)
      );
      await s.replaceContextRangeWithSummary({
        conversationId: cid,
        startOrdinal: 0,
        endOrdinal: 7,
        summaryId: "leaf",
      });
    });
    expect((await s.getContextItems(cid)).map((r) => r.ordinal)).toEqual(
      Array.from({ length: 25 }, (_, i) => i)
    );
    expect(await s.getSummaryMessageSeqRange("leaf")).toEqual({
      minSeq: 1,
      maxSeq: 8,
    });
    expect(await s.getContextTokenCount(cid)).toBe(2412);
    await expect(
      s.withTransaction(async () => {
        await s.insertSummary({
          summaryId: "bad",
          conversationId: cid,
          kind: "leaf",
          content: "must rollback",
          tokenCount: 1,
        });
        await s.replaceContextRangeWithSummary({
          conversationId: cid,
          startOrdinal: 2,
          endOrdinal: 1,
          summaryId: "bad",
        });
      })
    ).rejects.toThrow("Invalid");
    expect(await s.getSummary("bad")).toBeNull();
    let old = 0;
    for await (const _ of before.scan({ prefix: "context/" })) old++;
    expect(old).toBe(32);
    expect(await c.deleteMessages([messages[0].messageId])).toBe(0);
    expect((await c.getMessageById(messages[0].messageId))?.content).toBe(
      "quartz message 0"
    );
  });
  it("preserves upstream parent/child directions, deduplicates graph walks and rejects cycles", async () => {
    const { s, cid, messages } = await fixture(8);
    for (const [summaryId, kind] of [
      ["leaf", "leaf"],
      ["condensed", "condensed"],
    ] as const)
      await s.insertSummary({
        summaryId,
        conversationId: cid,
        kind,
        content: summaryId,
        tokenCount: 10,
      });
    await s.linkSummaryToMessages(
      "leaf",
      messages.map((r) => r.messageId)
    );
    await s.linkSummaryToParents("condensed", ["leaf"]);
    await s.linkSummaryToParents("condensed", ["leaf"]);
    expect(
      (await s.getSummaryParents("condensed")).map((r) => r.summaryId)
    ).toEqual(["leaf"]);
    expect(
      (await s.getSummaryChildren("leaf")).map((r) => r.summaryId)
    ).toEqual(["condensed"]);
    expect(await s.getSummaryMessageSeqRange("condensed")).toEqual({
      minSeq: 1,
      maxSeq: 8,
    });
    await expect(s.linkSummaryToParents("leaf", ["condensed"])).rejects.toThrow(
      "acyclic"
    );
  });
  it("stores text and binary file bytes in the native store and searches bounded prefixes", async () => {
    const { s, cid } = await fixture(1),
      bytes = Buffer.from("one\nquartz two\nthree");
    const row = await s.storeLargeFileBytes(
      {
        fileId: "file1",
        conversationId: cid,
        storageUri: "ignored",
        fileName: "a.txt",
      },
      bytes
    );
    expect(row.storageUri).toMatch(/^turbopuffer:\/\//);
    expect(
      await s.getLargeFileContent("file1", { largeFilesDir: "/must-not-read" })
    ).toBe(bytes.toString());
    expect(
      await s.largeFileBufferEquals("file1", bytes, {
        largeFilesDir: "/must-not-read",
      })
    ).toBe(true);
    const hits = await s.searchLargeFiles({
      conversationId: cid,
      query: "quartz",
      mode: "regex",
      largeFilesDir: "/must-not-read",
    });
    expect(hits[0]).toMatchObject({
      lineNumber: 2,
      byteOffset: 4,
      scanTruncated: false,
    });
    const binary = Buffer.from([0, 1, 255, 128, 10]);
    await s.storeLargeFileBytes(
      { fileId: "binary", conversationId: cid, storageUri: "ignored" },
      binary
    );
    expect(await s.getLargeFileBytes("binary")).toEqual(binary);
  });
  it("claims pending compaction only after children are ready and fences expired inference results", async () => {
    const { p, cid } = await fixture(8);
    await p.createBatch({
      batchId: "batch",
      conversationId: cid,
      sourceProjectionFingerprint: "projection",
      compactableStartOrdinal: 0,
      compactableEndOrdinal: 7,
      promptVersion: "v1",
      model: "fake",
    });
    for (const [nodeId, depth] of [
      ["leaf", 0],
      ["parent", 1],
    ] as const)
      await p.insertNode({
        nodeId,
        batchId: "batch",
        conversationId: cid,
        kind: depth ? "condensed" : "leaf",
        depth,
        ordinalStart: 0,
        ordinalEnd: 7,
        sourceFingerprint: nodeId,
        promptVersion: "v1",
        model: "fake",
      });
    await p.linkNodeToChildren("parent", [{ childNodeId: "leaf" }]);
    const early = new Date(1700000000000),
      later = new Date(early.getTime() + 1000);
    expect(
      (
        await p.claimNextPlannedNode({
          conversationId: cid,
          leaseOwner: "old",
          leaseExpiresAt: early,
          now: new Date(early.getTime() - 1000),
        })
      )?.nodeId
    ).toBe("leaf");
    expect(
      (
        await p.claimNextPlannedNode({
          conversationId: cid,
          leaseOwner: "new",
          leaseExpiresAt: later,
          now: early,
        })
      )?.leaseOwner
    ).toBe("new");
    expect(
      await p.markNodeReady({
        nodeId: "leaf",
        leaseOwner: "old",
        leaseExpiresAt: early,
        content: "stale",
        tokenCount: 1,
      })
    ).toBe(false);
    expect(
      await p.markNodeReady({
        nodeId: "leaf",
        leaseOwner: "new",
        leaseExpiresAt: later,
        content: "ready",
        tokenCount: 1,
      })
    ).toBe(true);
    expect(
      (
        await p.claimNextPlannedNode({
          conversationId: cid,
          leaseOwner: "parent",
          leaseExpiresAt: later,
          now: early,
        })
      )?.nodeId
    ).toBe("parent");
  });
  it("commits cursor, replay identity and gap markers with the same native root", async () => {
    const { db, cid, messages } = await fixture(3),
      cursor = new NativeTranscriptCursorStore(db),
      replay = new NativeUserReplayKeyStore(db),
      gaps = new NativeTranscriptGapStore(db);
    await db.transaction(async () => {
      await cursor.upsert({
        conversationId: cid,
        cursor: "opaque",
        frontierEntryId: "entry-2",
        frontierSeq: 3,
        origin: "fresh",
      });
      await replay.record(cid, [
        { entryId: "entry-0", idempotencyKey: "key", signature: "signature" },
      ]);
      await gaps.record(
        cid,
        [
          {
            firstEntryId: "gap",
            lastEntryId: "gap",
            firstVisibleSeq: 2,
            lastVisibleSeq: 2,
            entryCount: 1,
            prevMessageId: messages[0].messageId,
            nextMessageId: messages[2].messageId,
          },
        ],
        "test"
      );
    });
    expect((await cursor.get(cid))?.cursor).toBe("opaque");
    expect((await cursor.listStampedRows(cid)).size).toBe(3);
    expect(await cursor.countRowsBetweenSeq(cid, 1, 3)).toBe(1);
    expect((await replay.listRawUserContextKeys(cid))[0]).toEqual({
      entryId: "entry-0",
      observed: { idempotencyKey: "key", signature: "signature" },
    });
    expect(await gaps.totals()).toEqual({
      conversations: 1,
      gaps: 1,
      entries: 1,
      largestGap: 1,
    });
  });
  it("uses maintenance revisions and preserves focus history", async () => {
    const { db, c, cid } = await fixture(2),
      maintenance = new NativeCompactionMaintenanceStore(db),
      focus = new NativeFocusBriefStore(db);
    await maintenance.requestProactiveCompactionDebt({
      conversationId: cid,
      reason: "test",
    });
    const row = await maintenance.getConversationCompactionMaintenance(cid);
    expect(
      await maintenance.closeInactiveCompactionDebt({
        conversationId: cid,
        expectedRevision: row!.maintenanceRevision,
      })
    ).toBe(false);
    await c.archiveConversation(cid, "manual-reset");
    expect(
      await maintenance.closeInactiveCompactionDebt({
        conversationId: cid,
        expectedRevision: row!.maintenanceRevision,
      })
    ).toBe(true);
    const first = await focus.createFocusBrief({
      conversationId: cid,
      prompt: "focus",
      content: "first",
      status: "active",
    });
    const second = await focus.createFocusBrief({
      conversationId: cid,
      prompt: "focus",
      content: "second",
      status: "active",
      supersedeCurrentDrafts: true,
    });
    expect((await focus.getActiveFocusBrief(cid))?.briefId).toBe(
      second.briefId
    );
    expect((await focus.getFocusBrief(first.briefId))?.status).toBe(
      "superseded"
    );
  });
  it("passes native repositories to the real context assembler", async () => {
    const { c, s, cid } = await fixture(12),
      assembler = new ContextAssembler(c, s);
    const result = await assembler.assemble({
      conversationId: cid,
      tokenBudget: 4000,
      freshTailCount: 8,
    });
    expect(result.messages.length).toBe(12);
    expect(result.estimatedTokens).toBeGreaterThan(0);
  });
});

describe("native paging and recovery utilities", () => {
  it("bounds an 80-message tail by actual serialized bytes without truncating stored messages", async () => {
    const { c, cid } = await fixture(80),
      rows = await c.getLastMessages(cid, 80),
      budget = Buffer.byteLength(JSON.stringify(rows.slice(-4)));
    const tail = await c.recentTail(cid, 80, budget);
    expect(tail.map((row) => row.messageId)).toEqual(
      rows.slice(-4).map((row) => row.messageId)
    );
    expect(Buffer.byteLength(JSON.stringify(tail))).toBeLessThanOrEqual(budget);
    expect(await c.getMessageCount(cid)).toBe(80);
  });
  it("preserves native lifecycle state through an explicit export/restore", async () => {
    const { exportNative, restoreNative } = await import(
      "../src/storage/turbopuffer-native/transfer.js"
    );
    const f = await fixture(4),
      cursor = new NativeTranscriptCursorStore(f.db);
    await cursor.upsert({
      conversationId: f.cid,
      cursor: "opaque-checkpoint",
      frontierEntryId: "entry-3",
      frontierSeq: 4,
      origin: "fresh",
    });
    await f.s.storeLargeFileBytes(
      { fileId: "persisted", conversationId: f.cid, storageUri: "ignored" },
      Buffer.from([0, 255, 3, 128])
    );
    const lines: string[] = [];
    for await (const line of exportNative(f.db)) lines.push(line);
    const restored = await NativeDatabase.open({
      organizationId: "org1",
      agentId: "alice",
      namespacePrefix: "native-restored-test",
      io: new MemoryIo(),
    });
    await restoreNative(
      restored,
      (async function* () {
        yield* lines;
      })()
    );
    expect(
      await new NativeConversationStore(restored).getMessages(f.cid)
    ).toEqual(await f.c.getMessages(f.cid));
    expect(await new NativeTranscriptCursorStore(restored).get(f.cid)).toEqual(
      await cursor.get(f.cid)
    );
    expect(
      await new NativeSummaryStore(restored).getLargeFileBytes("persisted")
    ).toEqual(Buffer.from([0, 255, 3, 128]));
    expect((await f.db.head()).revision).toBeGreaterThan(0); // Original is retained.
  });
  it("reads a small file prefix from paged file chunks and preserves binary equality", async () => {
    const { db, s, cid, io } = await fixture(1),
      bytes = Buffer.alloc(2 * 1024 * 1024, 7);
    await s.storeLargeFileBytes(
      { fileId: "paged-file", conversationId: cid, storageUri: "ignored" },
      bytes
    );
    const read = io.read.bind(io);
    let chunkReads = 0;
    io.read = async (ids) => {
      const rows = await read(ids);
      chunkReads += rows.filter((row) =>
        row.record_key?.startsWith("file-chunks/")
      ).length;
      return rows;
    };
    expect(
      await new NativeSummaryStore(db).getLargeFileBytes("paged-file", {
        maxBytes: 100,
      })
    ).toEqual(bytes.subarray(0, 100));
    expect(chunkReads).toBe(1);
    expect(
      await s.largeFileBufferEquals("paged-file", bytes, {
        largeFilesDir: "/must-not-read",
      })
    ).toBe(true);
  });
});

describe("native derived ranges and search semantics", () => {
  it("updates cached ancestor ranges atomically when a source gains coverage", async () => {
    const { s, cid, messages } = await fixture(8);
    for (const summaryId of ["source", "ancestor"])
      await s.insertSummary({
        summaryId,
        conversationId: cid,
        kind: summaryId === "source" ? "leaf" : "condensed",
        content: summaryId,
        tokenCount: 2,
      });
    await s.linkSummaryToParents("ancestor", ["source"]);
    expect(await s.getSummaryMessageSeqRange("ancestor")).toEqual({
      minSeq: null,
      maxSeq: null,
    });
    await s.linkSummaryToMessages(
      "source",
      messages.slice(0, 4).map((row) => row.messageId)
    );
    expect(await s.getSummaryMessageSeqRange("ancestor")).toEqual({
      minSeq: 1,
      maxSeq: 4,
    });
    await s.linkSummaryToMessages(
      "source",
      messages.slice(4).map((row) => row.messageId)
    );
    expect(await s.getSummaryMessageSeqRange("ancestor")).toEqual({
      minSeq: 1,
      maxSeq: 8,
    });
  });
  it("preserves quoted phrases, literal punctuation groups and reference normalization", async () => {
    const { c, cid } = await fixture(1);
    await c.createMessagesBulk([
      {
        conversationId: cid,
        seq: 2,
        role: "user",
        content: "foo-bar quartz",
        tokenCount: 2,
      },
      {
        conversationId: cid,
        seq: 3,
        role: "user",
        content: "foo distant bar quartz",
        tokenCount: 4,
      },
      {
        conversationId: cid,
        seq: 4,
        role: "tool",
        content:
          "[LCM Tool Output: file_test]\nCall lcm_describe(secret_hint)\nExploration Summary:\nquartz",
        tokenCount: 5,
      },
    ]);
    expect(
      (
        await c.searchMessages({
          conversationId: cid,
          query: "foo_bar",
          mode: "full_text",
        })
      ).map((row) => row.messageId)
    ).toEqual([2]);
    expect(
      (
        await c.searchMessages({
          conversationId: cid,
          query: '"foo bar"',
          mode: "full_text",
        })
      ).map((row) => row.messageId)
    ).toEqual([2]);
    expect(
      await c.searchMessages({
        conversationId: cid,
        query: "secret_hint",
        mode: "full_text",
      })
    ).toEqual([]);
    expect(
      (
        await c.searchMessages({
          conversationId: cid,
          query: "(?<=foo-)bar",
          mode: "regex",
        })
      ).map((row) => row.messageId)
    ).toEqual([2]);
  });
});

it("counts identity hashes within the requested role and resolves explicit historical trust", async () => {
  const { c, cid, messages } = await fixture(1),
    hash = "explicit-shared-hash";
  await c.createMessage({
    conversationId: cid,
    seq: 2,
    role: "user",
    content: "user hash",
    tokenCount: 1,
    identityHash: hash,
  });
  await c.createMessage({
    conversationId: cid,
    seq: 3,
    role: "assistant",
    content: "assistant hash",
    tokenCount: 1,
    identityHash: hash,
  });
  expect(await c.countMessagesByIdentityHash(cid, "user", hash)).toBe(1);
  expect(await c.countMessagesByIdentityHash(cid, "assistant", hash)).toBe(1);
  expect(await c.countMessagesByIdentityHash(cid, "tool", hash)).toBe(0);
  await c.upsertMessageTranscriptAnchorTrust({
    messageId: messages[0].messageId,
    conversationId: cid,
    transcriptEntryId: "historical",
    trustState: "verified",
    source: "repair",
  });
  expect(await c.isTrustedTranscriptAnchor(cid, " historical ")).toBe(true);
  await c.deleteMessages([messages[0].messageId]);
  expect(await c.isTrustedTranscriptAnchor(cid, "historical")).toBe(false);
});

it("deduplicates reasoning only when the newest row has the canonical identity", async () => {
  const { c, cid } = await fixture(1);
  for (const [seq, identityHash] of [
    [2, "override"],
    [3, undefined],
  ] as const) {
    const row = await c.createMessage({
      conversationId: cid,
      seq,
      role: "assistant",
      content: "same answer",
      tokenCount: 3,
      identityHash,
    });
    await c.createMessageParts(row.messageId, [
      {
        sessionId: "s",
        partType: "text",
        ordinal: 0,
        metadata: JSON.stringify({
          topLevelReasoningField: "reasoning_content",
          topLevelReasoningContent: " ",
        }),
      },
    ]);
    expect(
      await c.hasPreviousReasonedMessageByIdentity(
        cid,
        "assistant",
        "same answer"
      )
    ).toBe(seq === 3);
  }
  expect(
    await c.hasPreviousReasonedMessageByIdentity(cid, "user", "same answer")
  ).toBe(false);
});

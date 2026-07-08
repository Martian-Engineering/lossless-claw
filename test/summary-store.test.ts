import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLcmMigrations } from "../src/db/migration.js";
import { getLcmDbFeatures } from "../src/db/features.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { SummaryStore } from "../src/store/summary-store.js";
import { RetrievalEngine } from "../src/retrieval.js";

function createStores() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const { fts5Available } = getLcmDbFeatures(db);
  runLcmMigrations(db, { fts5Available });
  return {
    db,
    conversationStore: new ConversationStore(db, { fts5Available }),
    summaryStore: new SummaryStore(db, { fts5Available }),
  };
}

describe("SummaryStore shallow-tree helpers", () => {
  it("returns conversation max depth and leaf links for message hits", async () => {
    const { conversationStore, summaryStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "summary-store-links",
      title: "Summary store links",
    });
    const [firstMessage, secondMessage, tailMessage] = await conversationStore.createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 1,
        role: "user",
        content: "first raw fact",
        tokenCount: 4,
      },
      {
        conversationId: conversation.conversationId,
        seq: 2,
        role: "assistant",
        content: "second raw fact",
        tokenCount: 4,
      },
      {
        conversationId: conversation.conversationId,
        seq: 3,
        role: "user",
        content: "fresh tail fact",
        tokenCount: 4,
      },
    ]);

    await summaryStore.insertSummary({
      summaryId: "sum_leaf_a",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "leaf A",
      tokenCount: 5,
    });
    await summaryStore.insertSummary({
      summaryId: "sum_leaf_b",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "leaf B",
      tokenCount: 5,
    });
    await summaryStore.insertSummary({
      summaryId: "sum_root",
      conversationId: conversation.conversationId,
      kind: "condensed",
      depth: 2,
      content: "root summary",
      tokenCount: 6,
    });

    await summaryStore.linkSummaryToMessages("sum_leaf_a", [firstMessage.messageId]);
    await summaryStore.linkSummaryToMessages("sum_leaf_b", [secondMessage.messageId]);

    await expect(
      summaryStore.getConversationMaxSummaryDepth(conversation.conversationId),
    ).resolves.toBe(2);

    await expect(
      summaryStore.getLeafSummaryLinksForMessageIds(conversation.conversationId, [
        tailMessage.messageId,
        secondMessage.messageId,
        firstMessage.messageId,
      ]),
    ).resolves.toEqual([
      {
        messageId: secondMessage.messageId,
        summaryId: "sum_leaf_b",
      },
      {
        messageId: firstMessage.messageId,
        summaryId: "sum_leaf_a",
      },
    ]);
  });

  it("uses content recency for fallback summary search ordering and time filters", async () => {
    const { db, conversationStore, summaryStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "summary-store-search-time",
      title: "Summary search time",
    });

    await summaryStore.insertSummary({
      summaryId: "sum_regex_old_content_recent_compaction",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "pagedrop regression historical request",
      tokenCount: 5,
      latestAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    await summaryStore.insertSummary({
      summaryId: "sum_regex_recent_content_older_compaction",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "pagedrop regression recent request",
      tokenCount: 5,
      latestAt: new Date("2026-01-09T00:00:00.000Z"),
    });

    db.prepare("UPDATE summaries SET created_at = ? WHERE summary_id = ?").run(
      "2026-01-10T00:00:00.000Z",
      "sum_regex_old_content_recent_compaction",
    );
    db.prepare("UPDATE summaries SET created_at = ? WHERE summary_id = ?").run(
      "2026-01-05T00:00:00.000Z",
      "sum_regex_recent_content_older_compaction",
    );

    await expect(
      summaryStore.searchSummaries({
        conversationId: conversation.conversationId,
        query: "pagedrop regression",
        mode: "regex",
        limit: 10,
      }),
    ).resolves.toMatchObject([
      {
        summaryId: "sum_regex_recent_content_older_compaction",
        createdAt: new Date("2026-01-09T00:00:00.000Z"),
      },
      {
        summaryId: "sum_regex_old_content_recent_compaction",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ]);

    await expect(
      summaryStore.searchSummaries({
        conversationId: conversation.conversationId,
        query: "pagedrop regression",
        mode: "regex",
        since: new Date("2026-01-05T00:00:00.000Z"),
        limit: 10,
      }),
    ).resolves.toMatchObject([
      {
        summaryId: "sum_regex_recent_content_older_compaction",
      },
    ]);
  });

  it("rejects large-file dedup reads outside the configured root", async () => {
    const { conversationStore, summaryStore } = createStores();
    const safeRoot = mkdtempSync(join(tmpdir(), "lcm-safe-root-"));
    const outsideRoot = mkdtempSync(join(tmpdir(), "lcm-outside-root-"));
    try {
      const conversation = await conversationStore.createConversation({
        sessionId: "summary-store-safe-large-file-read",
        title: "Summary store safe large file read",
      });
      const outsideFile = join(outsideRoot, "payload.txt");
      writeFileSync(outsideFile, "outside payload", "utf8");

      await summaryStore.insertLargeFile({
        fileId: "file_1234567890abcdef",
        conversationId: conversation.conversationId,
        fileName: "payload.txt",
        mimeType: "text/plain",
        byteSize: Buffer.byteLength("outside payload", "utf8"),
        storageUri: outsideFile,
        explorationSummary: "outside payload",
      });

      await expect(
        summaryStore.largeFileContentEquals("file_1234567890abcdef", "outside payload", {
          largeFilesDir: safeRoot,
        }),
      ).resolves.toBe(false);
      await expect(
        summaryStore.getLargeFileContent("file_1234567890abcdef", {
          largeFilesDir: safeRoot,
        }),
      ).resolves.toBeNull();
    } finally {
      rmSync(safeRoot, { recursive: true, force: true });
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it("compares large-file dedup content above the describe read cap", async () => {
    const { conversationStore, summaryStore } = createStores();
    const safeRoot = mkdtempSync(join(tmpdir(), "lcm-safe-large-root-"));
    try {
      const conversation = await conversationStore.createConversation({
        sessionId: "summary-store-large-dedup-read",
        title: "Summary store large dedup read",
      });
      const payload = `${"large payload line\n".repeat(36_000)}done`;
      const payloadPath = join(safeRoot, "large-payload.txt");
      writeFileSync(payloadPath, payload, "utf8");

      await summaryStore.insertLargeFile({
        fileId: "file_abcdef1234567890",
        conversationId: conversation.conversationId,
        fileName: "large-payload.txt",
        mimeType: "text/plain",
        byteSize: Buffer.byteLength(payload, "utf8"),
        storageUri: payloadPath,
        explorationSummary: "large payload",
      });

      await expect(
        summaryStore.largeFileContentEquals("file_abcdef1234567890", payload, {
          largeFilesDir: safeRoot,
        }),
      ).resolves.toBe(true);
    } finally {
      rmSync(safeRoot, { recursive: true, force: true });
    }
  });

  it("searches large file contents with regex and reports line numbers", async () => {
    const { conversationStore, summaryStore } = createStores();
    const safeRoot = mkdtempSync(join(tmpdir(), "lcm-search-large-files-"));
    try {
      const conversation = await conversationStore.createConversation({
        sessionId: "summary-store-search-large-files",
        title: "Summary store search large files",
      });
      const content = "alpha\nbeta\ngamma\ndelta\n";
      const payloadPath = join(safeRoot, "content.txt");
      writeFileSync(payloadPath, content, "utf8");

      await summaryStore.insertLargeFile({
        fileId: "file_searchable1234",
        conversationId: conversation.conversationId,
        fileName: "content.txt",
        mimeType: "text/plain",
        byteSize: Buffer.byteLength(content, "utf8"),
        storageUri: payloadPath,
      });

      const results = await summaryStore.searchLargeFiles({
        query: "gamma",
        mode: "regex",
        conversationId: conversation.conversationId,
        largeFilesDir: safeRoot,
      });

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        fileId: "file_searchable1234",
        fileName: "content.txt",
        matchedText: "gamma",
        lineNumber: 3,
        byteOffset: content.indexOf("gamma"),
      });
      expect(results[0].snippet).toContain("gamma");
    } finally {
      rmSync(safeRoot, { recursive: true, force: true });
    }
  });

  it("returns multiple regex matches per file up to the cap", async () => {
    const { conversationStore, summaryStore } = createStores();
    const safeRoot = mkdtempSync(join(tmpdir(), "lcm-search-multi-"));
    try {
      const conversation = await conversationStore.createConversation({
        sessionId: "summary-store-search-multi",
        title: "Summary store search multi",
      });
      const content = "hit one\nmiss\nhit two\nmiss\nhit three\n";
      const payloadPath = join(safeRoot, "multi.txt");
      writeFileSync(payloadPath, content, "utf8");

      await summaryStore.insertLargeFile({
        fileId: "file_multi12345678",
        conversationId: conversation.conversationId,
        fileName: "multi.txt",
        mimeType: "text/plain",
        byteSize: Buffer.byteLength(content, "utf8"),
        storageUri: payloadPath,
      });

      const results = await summaryStore.searchLargeFiles({
        query: "hit\\s\\w+",
        mode: "regex",
        conversationId: conversation.conversationId,
        largeFilesDir: safeRoot,
      });

      expect(results).toHaveLength(3);
      expect(results.map((r) => r.matchedText)).toEqual(["hit one", "hit two", "hit three"]);
      expect(results.map((r) => r.lineNumber)).toEqual([1, 3, 5]);
    } finally {
      rmSync(safeRoot, { recursive: true, force: true });
    }
  });

  it("filters large file search by fileIds", async () => {
    const { conversationStore, summaryStore } = createStores();
    const safeRoot = mkdtempSync(join(tmpdir(), "lcm-search-fileids-"));
    try {
      const conversation = await conversationStore.createConversation({
        sessionId: "summary-store-search-fileids",
        title: "Summary store search fileIds",
      });
      const sharedContent = "needle in haystack";

      for (const [fileId, name] of [
        ["file_include_12345", "include.txt"],
        ["file_exclude_67890", "exclude.txt"],
      ] as const) {
        const payloadPath = join(safeRoot, name);
        writeFileSync(payloadPath, sharedContent, "utf8");
        await summaryStore.insertLargeFile({
          fileId,
          conversationId: conversation.conversationId,
          fileName: name,
          mimeType: "text/plain",
          byteSize: Buffer.byteLength(sharedContent, "utf8"),
          storageUri: payloadPath,
        });
      }

      const results = await summaryStore.searchLargeFiles({
        query: "needle",
        mode: "regex",
        conversationId: conversation.conversationId,
        fileIds: ["file_include_12345"],
        largeFilesDir: safeRoot,
      });

      expect(results).toHaveLength(1);
      expect(results[0].fileId).toBe("file_include_12345");
    } finally {
      rmSync(safeRoot, { recursive: true, force: true });
    }
  });

  it("keeps fileIds constrained to the requested conversation scope", async () => {
    const { conversationStore, summaryStore } = createStores();
    const safeRoot = mkdtempSync(join(tmpdir(), "lcm-search-fileids-scope-"));
    try {
      const allowedConversation = await conversationStore.createConversation({
        sessionId: "summary-store-fileids-scope-allowed",
        title: "Summary store fileIds scope allowed",
      });
      const otherConversation = await conversationStore.createConversation({
        sessionId: "summary-store-fileids-scope-other",
        title: "Summary store fileIds scope other",
      });
      const allowedPath = join(safeRoot, "allowed.txt");
      const otherPath = join(safeRoot, "other.txt");
      writeFileSync(allowedPath, "allowed needle", "utf8");
      writeFileSync(otherPath, "other needle", "utf8");

      await summaryStore.insertLargeFile({
        fileId: "file_allowed_scope",
        conversationId: allowedConversation.conversationId,
        fileName: "allowed.txt",
        mimeType: "text/plain",
        byteSize: Buffer.byteLength("allowed needle", "utf8"),
        storageUri: allowedPath,
      });
      await summaryStore.insertLargeFile({
        fileId: "file_other_scope",
        conversationId: otherConversation.conversationId,
        fileName: "other.txt",
        mimeType: "text/plain",
        byteSize: Buffer.byteLength("other needle", "utf8"),
        storageUri: otherPath,
      });

      const scopedResults = await summaryStore.searchLargeFiles({
        query: "needle",
        mode: "regex",
        conversationId: allowedConversation.conversationId,
        fileIds: ["file_other_scope"],
        largeFilesDir: safeRoot,
      });
      expect(scopedResults).toHaveLength(0);

      const allConversationResults = await summaryStore.searchLargeFiles({
        query: "needle",
        mode: "regex",
        allConversations: true,
        fileIds: ["file_other_scope"],
        largeFilesDir: safeRoot,
      });
      expect(allConversationResults).toHaveLength(1);
      expect(allConversationResults[0].fileId).toBe("file_other_scope");
    } finally {
      rmSync(safeRoot, { recursive: true, force: true });
    }
  });

  it("respects maxBytesPerFile when searching large files", async () => {
    const { conversationStore, summaryStore } = createStores();
    const safeRoot = mkdtempSync(join(tmpdir(), "lcm-search-maxbytes-"));
    try {
      const conversation = await conversationStore.createConversation({
        sessionId: "summary-store-search-maxbytes",
        title: "Summary store search maxBytes",
      });
      const prefix = "aaa\n".repeat(100);
      const suffix = "ZZZ_FIND_ME_ZZZ";
      const content = prefix + suffix;
      const payloadPath = join(safeRoot, "big.txt");
      writeFileSync(payloadPath, content, "utf8");

      await summaryStore.insertLargeFile({
        fileId: "file_maxbytes_12345",
        conversationId: conversation.conversationId,
        fileName: "big.txt",
        mimeType: "text/plain",
        byteSize: Buffer.byteLength(content, "utf8"),
        storageUri: payloadPath,
      });

      const results = await summaryStore.searchLargeFiles({
        query: "ZZZ_FIND_ME_ZZZ",
        mode: "regex",
        conversationId: conversation.conversationId,
        largeFilesDir: safeRoot,
        maxBytesPerFile: 50,
      });

      expect(results).toHaveLength(0);
    } finally {
      rmSync(safeRoot, { recursive: true, force: true });
    }
  });

  it("rejects unsafe regex patterns when searching large files", async () => {
    const { conversationStore, summaryStore } = createStores();
    const safeRoot = mkdtempSync(join(tmpdir(), "lcm-search-regex-guard-"));
    try {
      const conversation = await conversationStore.createConversation({
        sessionId: "summary-store-search-regex-guard",
        title: "Summary store search regex guard",
      });
      const content = "aaaaaaaaaaaaaaaaaaaaaaaa";
      const payloadPath = join(safeRoot, "guard.txt");
      writeFileSync(payloadPath, content, "utf8");

      await summaryStore.insertLargeFile({
        fileId: "file_regex_guard_12345",
        conversationId: conversation.conversationId,
        fileName: "guard.txt",
        mimeType: "text/plain",
        byteSize: Buffer.byteLength(content, "utf8"),
        storageUri: payloadPath,
      });

      const nestedQuantifierResults = await summaryStore.searchLargeFiles({
        query: "(a+)+",
        mode: "regex",
        conversationId: conversation.conversationId,
        largeFilesDir: safeRoot,
      });
      expect(nestedQuantifierResults).toHaveLength(0);

      const quantifiedAlternationResults = await summaryStore.searchLargeFiles({
        query: "(a|aa)+$",
        mode: "regex",
        conversationId: conversation.conversationId,
        largeFilesDir: safeRoot,
      });
      expect(quantifiedAlternationResults).toHaveLength(0);

      const boundedNestedQuantifierResults = await summaryStore.searchLargeFiles({
        query: "(a{1,2})+$",
        mode: "regex",
        conversationId: conversation.conversationId,
        largeFilesDir: safeRoot,
      });
      expect(boundedNestedQuantifierResults).toHaveLength(0);

      const safeResults = await summaryStore.searchLargeFiles({
        query: "a+",
        mode: "regex",
        conversationId: conversation.conversationId,
        largeFilesDir: safeRoot,
      });
      expect(safeResults).toHaveLength(1);
      expect(safeResults[0]).toMatchObject({
        fileId: "file_regex_guard_12345",
        scannedBytes: Buffer.byteLength(content, "utf8"),
        scanByteLimit: 512_000,
        scanTruncated: false,
      });
    } finally {
      rmSync(safeRoot, { recursive: true, force: true });
    }
  });

  it("skips non-text large files when searching contents", async () => {
    const { conversationStore, summaryStore } = createStores();
    const safeRoot = mkdtempSync(join(tmpdir(), "lcm-search-binary-"));
    try {
      const conversation = await conversationStore.createConversation({
        sessionId: "summary-store-search-binary",
        title: "Summary store search binary",
      });
      const content = "definitely not an image";
      const payloadPath = join(safeRoot, "fake.png");
      writeFileSync(payloadPath, content, "utf8");

      await summaryStore.insertLargeFile({
        fileId: "file_binary_12345",
        conversationId: conversation.conversationId,
        fileName: "fake.png",
        mimeType: "image/png",
        byteSize: Buffer.byteLength(content, "utf8"),
        storageUri: payloadPath,
      });

      const results = await summaryStore.searchLargeFiles({
        query: "definitely",
        mode: "regex",
        conversationId: conversation.conversationId,
        largeFilesDir: safeRoot,
      });

      expect(results).toHaveLength(0);
    } finally {
      rmSync(safeRoot, { recursive: true, force: true });
    }
  });

  it("reports large file byteOffset as a UTF-8 byte offset", async () => {
    const { conversationStore, summaryStore } = createStores();
    const safeRoot = mkdtempSync(join(tmpdir(), "lcm-search-byte-offset-"));
    try {
      const conversation = await conversationStore.createConversation({
        sessionId: "summary-store-byte-offset",
        title: "Summary store byte offset",
      });
      const content = "πreamble\nneedle";
      const payloadPath = join(safeRoot, "unicode.txt");
      writeFileSync(payloadPath, content, "utf8");

      await summaryStore.insertLargeFile({
        fileId: "file_byte_offset_12345",
        conversationId: conversation.conversationId,
        fileName: "unicode.txt",
        mimeType: "text/plain",
        byteSize: Buffer.byteLength(content, "utf8"),
        storageUri: payloadPath,
      });

      const results = await summaryStore.searchLargeFiles({
        query: "needle",
        mode: "regex",
        conversationId: conversation.conversationId,
        largeFilesDir: safeRoot,
      });

      expect(results).toHaveLength(1);
      expect(results[0].byteOffset).toBe(Buffer.byteLength("πreamble\n", "utf8"));
    } finally {
      rmSync(safeRoot, { recursive: true, force: true });
    }
  });

  it("searches large files with full_text mode requiring all terms", async () => {
    const { conversationStore, summaryStore } = createStores();
    const safeRoot = mkdtempSync(join(tmpdir(), "lcm-search-fulltext-"));
    try {
      const conversation = await conversationStore.createConversation({
        sessionId: "summary-store-search-fulltext",
        title: "Summary store search fullText",
      });
      const content = "quick brown fox jumps over the lazy dog";
      const payloadPath = join(safeRoot, "animals.txt");
      writeFileSync(payloadPath, content, "utf8");

      await summaryStore.insertLargeFile({
        fileId: "file_fulltext_12345",
        conversationId: conversation.conversationId,
        fileName: "animals.txt",
        mimeType: "text/plain",
        byteSize: Buffer.byteLength(content, "utf8"),
        storageUri: payloadPath,
      });

      const allTerms = await summaryStore.searchLargeFiles({
        query: "quick fox",
        mode: "full_text",
        conversationId: conversation.conversationId,
        largeFilesDir: safeRoot,
      });
      expect(allTerms).toHaveLength(1);

      const missingTerm = await summaryStore.searchLargeFiles({
        query: "quick zebra",
        mode: "full_text",
        conversationId: conversation.conversationId,
        largeFilesDir: safeRoot,
      });
      expect(missingTerm).toHaveLength(0);
    } finally {
      rmSync(safeRoot, { recursive: true, force: true });
    }
  });

  it("searches large files across all conversations when allConversations is true", async () => {
    const { conversationStore, summaryStore } = createStores();
    const safeRoot = mkdtempSync(join(tmpdir(), "lcm-search-all-convs-"));
    try {
      const conv1 = await conversationStore.createConversation({
        sessionId: "summary-store-search-all-1",
        title: "Summary store search all 1",
      });
      const conv2 = await conversationStore.createConversation({
        sessionId: "summary-store-search-all-2",
        title: "Summary store search all 2",
      });

      const content1 = "needle alpha";
      const content2 = "needle beta";
      const path1 = join(safeRoot, "a.txt");
      const path2 = join(safeRoot, "b.txt");
      writeFileSync(path1, content1, "utf8");
      writeFileSync(path2, content2, "utf8");

      await summaryStore.insertLargeFile({
        fileId: "file_all_1",
        conversationId: conv1.conversationId,
        fileName: "a.txt",
        mimeType: "text/plain",
        byteSize: Buffer.byteLength(content1, "utf8"),
        storageUri: path1,
      });
      await summaryStore.insertLargeFile({
        fileId: "file_all_2",
        conversationId: conv2.conversationId,
        fileName: "b.txt",
        mimeType: "text/plain",
        byteSize: Buffer.byteLength(content2, "utf8"),
        storageUri: path2,
      });

      const results = await summaryStore.searchLargeFiles({
        query: "needle",
        mode: "regex",
        allConversations: true,
        largeFilesDir: safeRoot,
      });

      expect(results).toHaveLength(2);
      expect(results.map((r) => r.fileId).sort()).toEqual(["file_all_1", "file_all_2"]);
    } finally {
      rmSync(safeRoot, { recursive: true, force: true });
    }
  });

  it("stores and returns large file lineCount", async () => {
    const { conversationStore, summaryStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "summary-store-line-count",
      title: "Summary store line count",
    });

    const record = await summaryStore.insertLargeFile({
      fileId: "file_linecount_12345",
      conversationId: conversation.conversationId,
      fileName: "lines.txt",
      mimeType: "text/plain",
      byteSize: 100,
      lineCount: 42,
      storageUri: "/tmp/lines.txt",
      explorationSummary: "line count test",
    });

    expect(record.lineCount).toBe(42);

    const fetched = await summaryStore.getLargeFile("file_linecount_12345");
    expect(fetched?.lineCount).toBe(42);

    const byConversation = await summaryStore.getLargeFilesByConversation(conversation.conversationId);
    expect(byConversation[0]?.lineCount).toBe(42);
  });

  it("defaults large file lineCount to null when omitted", async () => {
    const { conversationStore, summaryStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "summary-store-line-count-null",
      title: "Summary store line count null",
    });

    const record = await summaryStore.insertLargeFile({
      fileId: "file_linecount_null",
      conversationId: conversation.conversationId,
      fileName: "legacy.txt",
      mimeType: "text/plain",
      byteSize: 100,
      storageUri: "/tmp/legacy.txt",
    });

    expect(record.lineCount).toBeNull();
  });

  it("describes a large file with startLine/endLine range", async () => {
    const { conversationStore, summaryStore } = createStores();
    const safeRoot = mkdtempSync(join(tmpdir(), "lcm-describe-range-"));
    try {
      const conversation = await conversationStore.createConversation({
        sessionId: "summary-store-describe-range",
        title: "Summary store describe range",
      });
      const content = ["line one", "line two", "line three", "line four", "line five"].join("\n");
      const payloadPath = join(safeRoot, "range.txt");
      writeFileSync(payloadPath, content, "utf8");

      await summaryStore.insertLargeFile({
        fileId: "file_range_12345",
        conversationId: conversation.conversationId,
        fileName: "range.txt",
        mimeType: "text/plain",
        byteSize: Buffer.byteLength(content, "utf8"),
        lineCount: 5,
        storageUri: payloadPath,
        explorationSummary: "range test",
      });

      const retrieval = new RetrievalEngine(conversationStore, summaryStore);
      const result = await retrieval.describe("file_range_12345", {
        expandFile: true,
        startLine: 2,
        endLine: 4,
        largeFilesDir: safeRoot,
      });

      expect(result?.type).toBe("file");
      expect(result?.file?.content).toBe("line two\nline three\nline four");
      expect(result?.file?.contentTruncated).toBe(false);
    } finally {
      rmSync(safeRoot, { recursive: true, force: true });
    }
  });

  it("describes a large file from startLine to end when endLine is omitted", async () => {
    const { conversationStore, summaryStore } = createStores();
    const safeRoot = mkdtempSync(join(tmpdir(), "lcm-describe-range-open-"));
    try {
      const conversation = await conversationStore.createConversation({
        sessionId: "summary-store-describe-range-open",
        title: "Summary store describe range open",
      });
      const content = ["alpha", "beta", "gamma", "delta"].join("\n");
      const payloadPath = join(safeRoot, "open.txt");
      writeFileSync(payloadPath, content, "utf8");

      await summaryStore.insertLargeFile({
        fileId: "file_range_open_12345",
        conversationId: conversation.conversationId,
        fileName: "open.txt",
        mimeType: "text/plain",
        byteSize: Buffer.byteLength(content, "utf8"),
        lineCount: 4,
        storageUri: payloadPath,
        explorationSummary: "open range test",
      });

      const retrieval = new RetrievalEngine(conversationStore, summaryStore);
      const result = await retrieval.describe("file_range_open_12345", {
        expandFile: true,
        startLine: 3,
        largeFilesDir: safeRoot,
      });

      expect(result?.file?.content).toBe("gamma\ndelta");
      expect(result?.file?.contentTruncated).toBe(false);
    } finally {
      rmSync(safeRoot, { recursive: true, force: true });
    }
  });

  it("reports truncation when a line-range read cannot reach the requested endLine", async () => {
    const { conversationStore, summaryStore } = createStores();
    const safeRoot = mkdtempSync(join(tmpdir(), "lcm-describe-range-trunc-"));
    try {
      const conversation = await conversationStore.createConversation({
        sessionId: "summary-store-describe-range-trunc",
        title: "Summary store describe range truncation",
      });
      const content = ["one", "two", "three", "four", "five"].join("\n");
      const payloadPath = join(safeRoot, "trunc.txt");
      writeFileSync(payloadPath, content, "utf8");

      await summaryStore.insertLargeFile({
        fileId: "file_range_trunc_12345",
        conversationId: conversation.conversationId,
        fileName: "trunc.txt",
        mimeType: "text/plain",
        byteSize: Buffer.byteLength(content, "utf8"),
        lineCount: 5,
        storageUri: payloadPath,
        explorationSummary: "truncation test",
      });

      const retrieval = new RetrievalEngine(conversationStore, summaryStore);
      const result = await retrieval.describe("file_range_trunc_12345", {
        expandFile: true,
        startLine: 2,
        endLine: 10,
        largeFilesDir: safeRoot,
      });

      expect(result?.file?.content).toBe("two\nthree\nfour\nfive");
      expect(result?.file?.contentTruncated).toBe(true);
    } finally {
      rmSync(safeRoot, { recursive: true, force: true });
    }
  });

  it("preserves complete multi-byte UTF-8 characters at the byte budget boundary", async () => {
    const { conversationStore, summaryStore } = createStores();
    const safeRoot = mkdtempSync(join(tmpdir(), "lcm-describe-range-utf8-"));
    try {
      const conversation = await conversationStore.createConversation({
        sessionId: "summary-store-describe-range-utf8",
        title: "Summary store describe range utf8",
      });
      // "中" is U+4E2D, UTF-8: E4 B8 AD (3 bytes). Build lines that end right at a boundary.
      const lines = ["alpha", "中", "beta", "国", "gamma"];
      const content = lines.join("\n");
      const payloadPath = join(safeRoot, "utf8.txt");
      writeFileSync(payloadPath, content, "utf8");

      await summaryStore.insertLargeFile({
        fileId: "file_range_utf8_12345",
        conversationId: conversation.conversationId,
        fileName: "utf8.txt",
        mimeType: "text/plain",
        byteSize: Buffer.byteLength(content, "utf8"),
        lineCount: lines.length,
        storageUri: payloadPath,
        explorationSummary: "utf8 boundary test",
      });

      const retrieval = new RetrievalEngine(conversationStore, summaryStore);
      const result = await retrieval.describe("file_range_utf8_12345", {
        expandFile: true,
        startLine: 1,
        endLine: lines.length,
        largeFilesDir: safeRoot,
      });

      expect(result?.file?.content).toBe(content);
      expect(result?.file?.content).not.toContain("\uFFFD");
    } finally {
      rmSync(safeRoot, { recursive: true, force: true });
    }
  });

  it("preserves a trailing multi-byte UTF-8 character in line-range reads", async () => {
    const { conversationStore, summaryStore } = createStores();
    const safeRoot = mkdtempSync(join(tmpdir(), "lcm-describe-range-trailing-utf8-"));
    try {
      const conversation = await conversationStore.createConversation({
        sessionId: "summary-store-describe-range-trailing-utf8",
        title: "Summary store describe range trailing utf8",
      });
      const content = "alpha\n中";
      const payloadPath = join(safeRoot, "trailing-utf8.txt");
      writeFileSync(payloadPath, content, "utf8");

      await summaryStore.insertLargeFile({
        fileId: "file_range_trailing_utf8",
        conversationId: conversation.conversationId,
        fileName: "trailing-utf8.txt",
        mimeType: "text/plain",
        byteSize: Buffer.byteLength(content, "utf8"),
        lineCount: 2,
        storageUri: payloadPath,
        explorationSummary: "trailing utf8 boundary test",
      });

      const retrieval = new RetrievalEngine(conversationStore, summaryStore);
      const result = await retrieval.describe("file_range_trailing_utf8", {
        expandFile: true,
        startLine: 1,
        largeFilesDir: safeRoot,
      });

      expect(result?.file?.content).toBe(content);
      expect(result?.file?.contentTruncated).toBe(false);
    } finally {
      rmSync(safeRoot, { recursive: true, force: true });
    }
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeLcmConnection, getLcmConnection } from "../src/db/connection.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { SummaryStore } from "../src/store/summary-store.js";

const tempDirs: string[] = [];

afterEach(() => {
  closeLcmConnection();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("SummaryStore tool_result_offloads", () => {
  it("stores pending offloads and transitions them through failed/rewritten states", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-offloads-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "offloads.db");
    const db = getLcmConnection(dbPath);

    runLcmMigrations(db, { fts5Available: false });

    const conversationStore = new ConversationStore(db, { fts5Available: false });
    const summaryStore = new SummaryStore(db, { fts5Available: false });

    const conversation = await conversationStore.createConversation({
      sessionId: "offload-session",
      title: "Tool offloads",
    });
    const message = await conversationStore.createMessage({
      conversationId: conversation.conversationId,
      seq: 1,
      role: "tool",
      content: "",
      tokenCount: 0,
    });
    await summaryStore.insertLargeFile({
      fileId: "file_deadbeefcafefeed",
      conversationId: conversation.conversationId,
      fileName: "tool-result-exec.txt",
      mimeType: "text/plain",
      byteSize: 2048,
      storageUri: "/tmp/tool-result-exec.txt",
      explorationSummary: "Stored tool output",
    });
    await summaryStore.insertLargeFile({
      fileId: "file_deadbeefcafef00d",
      conversationId: conversation.conversationId,
      fileName: "tool-result-read.txt",
      mimeType: "text/plain",
      byteSize: 1024,
      storageUri: "/tmp/tool-result-read.txt",
      explorationSummary: "Stored read output",
    });

    const first = await summaryStore.insertToolResultOffload({
      conversationId: conversation.conversationId,
      sessionId: "offload-session",
      fileId: "file_deadbeefcafefeed",
      toolCallId: "call_failed",
      toolName: "exec",
      messageTimestamp: 1001,
      originalCharCount: 9000,
      originalByteSize: 9100,
      previewText: "preview failed",
      replacementMessageJson: "{\"role\":\"toolResult\"}",
    });
    expect((await summaryStore.getToolResultOffload(first.offloadId))?.rewriteState).toBe("pending");

    let pending = await summaryStore.getPendingToolResultOffloads("offload-session");
    expect(pending.map((record) => record.toolCallId)).toEqual(["call_failed"]);
    expect(pending[0]?.messageId).toBeNull();

    await summaryStore.attachToolResultOffloadMessageId(first.offloadId, message.messageId);
    pending = await summaryStore.getPendingToolResultOffloads("offload-session");
    expect(pending[0]?.messageId).toBe(message.messageId);

    await summaryStore.markToolResultOffloadFailed(first.offloadId, "rewrite boom");
    pending = await summaryStore.getPendingToolResultOffloads("offload-session");
    expect(pending).toEqual([]);

    const failedRecord = await summaryStore.getToolResultOffload(first.offloadId);
    expect(failedRecord).not.toBeNull();
    expect(failedRecord?.rewriteState).toBe("failed");
    expect(failedRecord?.lastError).toBe("rewrite boom");

    const failedRow = db
      .prepare(
        `SELECT rewrite_state, rewrite_attempts, last_error, transcript_entry_id
         FROM tool_result_offloads
         WHERE offload_id = ?`,
      )
      .get(first.offloadId) as {
      rewrite_state: string;
      rewrite_attempts: number;
      last_error: string | null;
      transcript_entry_id: string | null;
    };
    expect(failedRow.rewrite_state).toBe("failed");
    expect(failedRow.rewrite_attempts).toBe(1);
    expect(failedRow.last_error).toBe("rewrite boom");
    expect(failedRow.transcript_entry_id).toBeNull();

    const second = await summaryStore.insertToolResultOffload({
      conversationId: conversation.conversationId,
      sessionId: "offload-session",
      messageId: message.messageId,
      fileId: "file_deadbeefcafef00d",
      toolCallId: "call_rewritten",
      toolName: "read",
      messageTimestamp: 1002,
      originalCharCount: 12000,
      originalByteSize: 12100,
      previewText: "preview rewritten",
      replacementMessageJson: "{\"role\":\"toolResult\"}",
    });

    pending = await summaryStore.getPendingToolResultOffloads("offload-session");
    expect(pending.map((record) => record.toolCallId)).toEqual(["call_rewritten"]);

    await summaryStore.markToolResultOffloadRewritten(second.offloadId, "entry_2");
    pending = await summaryStore.getPendingToolResultOffloads("offload-session");
    expect(pending).toEqual([]);

    const rewrittenRecord = await summaryStore.getToolResultOffload(second.offloadId);
    expect(rewrittenRecord).not.toBeNull();
    expect(rewrittenRecord?.rewriteState).toBe("rewritten");
    expect(rewrittenRecord?.transcriptEntryId).toBe("entry_2");

    const rewrittenRow = db
      .prepare(
        `SELECT rewrite_state, rewrite_attempts, last_error, transcript_entry_id, rewritten_at
         FROM tool_result_offloads
         WHERE offload_id = ?`,
      )
      .get(second.offloadId) as {
      rewrite_state: string;
      rewrite_attempts: number;
      last_error: string | null;
      transcript_entry_id: string | null;
      rewritten_at: string | null;
    };
    expect(rewrittenRow.rewrite_state).toBe("rewritten");
    expect(rewrittenRow.rewrite_attempts).toBe(1);
    expect(rewrittenRow.last_error).toBeNull();
    expect(rewrittenRow.transcript_entry_id).toBe("entry_2");
    expect(rewrittenRow.rewritten_at).toBeTypeOf("string");
  });
});

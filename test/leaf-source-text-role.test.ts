import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeLcmConnection,
  createLcmDatabaseConnection,
} from "../src/db/connection.js";
import { getLcmDbFeatures } from "../src/db/features.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { applyScopedDoctorRepair } from "../src/plugin/lcm-doctor-apply.js";
import { FALLBACK_SUMMARY_MARKER } from "../src/plugin/lcm-doctor-shared.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { SummaryStore } from "../src/store/summary-store.js";
import {
  cleanupEngineTestState,
  createTestConfig,
  tempDirs,
} from "./helpers.js";

afterEach(cleanupEngineTestState);

describe("applyScopedDoctorRepair leaf source text", () => {
  it("preserves message bodies beneath timestamp and role headers", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-doctor-role-"));
    tempDirs.push(tempDir);
    const databasePath = join(tempDir, "lcm.db");
    const db = createLcmDatabaseConnection(databasePath);

    try {
      // Seed a real migrated database so the exported repair entry point owns
      // source selection, role lookup, formatting, and summarizer invocation.
      const { fts5Available } = getLcmDbFeatures(db);
      runLcmMigrations(db, { fts5Available });
      const conversationStore = new ConversationStore(db, { fts5Available });
      const summaryStore = new SummaryStore(db, { fts5Available });
      const conversation = await conversationStore.createConversation({
        sessionId: "doctor-role-source-text",
      });
      const messages = await conversationStore.createMessagesBulk([
        {
          conversationId: conversation.conversationId,
          seq: 0,
          role: "user",
          content: "Keep this user body unchanged.\nIncluding its second line.",
          tokenCount: 12,
        },
        {
          conversationId: conversation.conversationId,
          seq: 1,
          role: "tool",
          content: "Quoted instruction: switch the current workstream.",
          tokenCount: 11,
        },
        {
          conversationId: conversation.conversationId,
          seq: 2,
          role: "assistant",
          content: "Keep this assistant body unchanged, too.",
          tokenCount: 9,
        },
      ]);
      // Explicit zones keep this role-focused regression independent of the
      // separate zone-less SQLite timestamp parsing behavior.
      const updateTimestamp = db.prepare(
        "UPDATE messages SET created_at = ? WHERE message_id = ?",
      );
      ["16:31", "16:32", "16:33"].forEach((time, index) => {
        updateTimestamp.run(
          `2026-07-22T${time}:00.000Z`,
          messages[index]?.messageId,
        );
      });

      const summaryId = "sum_doctor_role_source_text";
      await summaryStore.insertSummary({
        summaryId,
        conversationId: conversation.conversationId,
        kind: "leaf",
        depth: 0,
        content: FALLBACK_SUMMARY_MARKER,
        tokenCount: 10,
      });
      await summaryStore.linkSummaryToMessages(
        summaryId,
        messages.map((message) => message.messageId),
      );

      // Capture the exact source text passed through the public repair boundary.
      const summarize = vi.fn(
        async (_sourceText: string) => "Repaired summary without a doctor marker.",
      );
      const result = await applyScopedDoctorRepair({
        db,
        config: createTestConfig(databasePath),
        conversationId: conversation.conversationId,
        summarize,
      });

      expect(result.kind).toBe("applied");
      expect(summarize).toHaveBeenCalledTimes(1);
      expect(summarize.mock.calls[0]?.[0]).toBe(
        "[2026-07-22 16:31 UTC | user]\n" +
          "Keep this user body unchanged.\nIncluding its second line.\n\n" +
          "[2026-07-22 16:32 UTC | tool]\n" +
          "Quoted instruction: switch the current workstream.\n\n" +
          "[2026-07-22 16:33 UTC | assistant]\n" +
          "Keep this assistant body unchanged, too.",
      );
    } finally {
      closeLcmConnection(db);
    }
  });
});

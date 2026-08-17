import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLcmDatabaseConnection } from "../src/db/connection.js";
import { LcmContextEngine } from "../src/engine.js";
import type { AgentMessage } from "../src/openclaw-bridge.js";
import type { VisibleSessionTranscriptMessageEntry } from "../src/types.js";
import {
  cleanupEngineTestState,
  createTestConfig,
  createTestDeps,
  tempDirs,
} from "./helpers.js";

afterEach(cleanupEngineTestState);

describe("gateway restart transcript frontier", () => {
  it("persists the first post-restart turn and reopens it durably", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-restart-frontier-"));
    tempDirs.push(tempDir);
    const databasePath = join(tempDir, "lcm.db");
    const sessionId = "restart-frontier-session";
    const sessionKey = "agent:main:restart-frontier-session";
    let visibleEntries: VisibleSessionTranscriptMessageEntry[] = [
      {
        entryId: "entry-user-before-restart",
        parentId: null,
        seq: 1,
        role: "user",
        message: { role: "user", content: "question before restart" },
        createdAt: "2026-08-17T12:00:00.000Z",
      },
      {
        entryId: "entry-assistant-before-restart",
        parentId: "entry-user-before-restart",
        seq: 2,
        role: "assistant",
        message: { role: "assistant", content: "answer before restart" },
        createdAt: "2026-08-17T12:00:01.000Z",
      },
    ];
    const readVisibleSessionTranscriptMessageEntries = vi.fn(async () => visibleEntries);
    const openEngine = () => {
      const config = createTestConfig(databasePath);
      return new LcmContextEngine(
        createTestDeps(config, { readVisibleSessionTranscriptMessageEntries }),
        createLcmDatabaseConnection(databasePath),
      );
    };
    const runtimeContext = {
      transcriptStorage: { kind: "sqlite" },
      sessionTarget: {
        agentId: "main",
        sessionId,
        sessionKey,
        storePath: "/tmp/openclaw-agent.sqlite",
      },
    };

    // Establish the durable pre-restart frontier, then close the engine exactly
    // as gateway_stop does before a retained factory opens a new connection.
    const firstEngine = openEngine();
    await expect(
      firstEngine.bootstrap({ sessionId, sessionKey, runtimeContext }),
    ).resolves.toMatchObject({ bootstrapped: true, importedMessages: 2 });
    await firstEngine.dispose();

    // The host-visible transcript has flushed the new user row but not the
    // assistant response when the first post-restart afterTurn callback fires.
    visibleEntries = [
      ...visibleEntries,
      {
        entryId: "entry-user-after-restart",
        parentId: "entry-assistant-before-restart",
        seq: 3,
        role: "user",
        message: { role: "user", content: "first question after restart" },
        createdAt: "2026-08-17T12:01:00.000Z",
      },
    ];
    const restartedEngine = openEngine();
    await expect(
      restartedEngine.afterTurn({
        sessionId,
        sessionKey,
        sessionFile: "/tmp/ignored-restart-frontier.jsonl",
        messages: [
          { role: "user", content: "first question after restart" },
          { role: "assistant", content: "first answer after restart" },
        ] satisfies AgentMessage[],
        prePromptMessageCount: 0,
        tokenBudget: 30_000,
        runtimeContext,
      }),
    ).resolves.toBeUndefined();

    // Reconcile should import the flushed user frontier and afterTurn should
    // append only the still-unflushed assistant suffix.
    const conversation = await restartedEngine
      .getConversationStore()
      .getConversationForSession({ sessionId, sessionKey });
    expect(conversation).not.toBeNull();
    await expect(
      restartedEngine.getConversationStore().getMessages(conversation!.conversationId),
    ).resolves.toMatchObject([
      { role: "user", content: "question before restart" },
      { role: "assistant", content: "answer before restart" },
      { role: "user", content: "first question after restart" },
      { role: "assistant", content: "first answer after restart" },
    ]);
    await restartedEngine.dispose();

    // A second reopen proves the post-restart turn was durable, not merely
    // visible through connection-local state.
    const verificationEngine = openEngine();
    const reopenedConversation = await verificationEngine
      .getConversationStore()
      .getConversationForSession({ sessionId, sessionKey });
    expect(reopenedConversation?.conversationId).toBe(conversation!.conversationId);
    const durableMessages = await verificationEngine
      .getConversationStore()
      .getMessages(reopenedConversation!.conversationId);
    expect(durableMessages.map((message) => message.content)).toEqual([
      "question before restart",
      "answer before restart",
      "first question after restart",
      "first answer after restart",
    ]);
    await verificationEngine.dispose();
  });
});

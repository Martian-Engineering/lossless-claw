import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runSessionMigration } from "../src/migrate-sessions.js";
import { createLcmDatabaseConnection } from "../src/db/connection.js";
import { LcmContextEngine } from "../src/engine.js";
import { cleanupEngineTestState, createTestConfig, createTestDeps, tempDirs } from "./helpers.js";

afterEach(cleanupEngineTestState);

it("keeps the imported early history in the active conversation after native host bootstrap and a new turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "lcm-codex-continuation-"));
  tempDirs.push(root);
  const dbPath = join(root, "lcm.db");
  const file = join(root, "rollout.jsonl");
  const sessionId = "oc-synthetic-destination";
  const sessionKey = "agent:k:synthetic-destination";
  const records = Array.from({ length: 300 }, (_, i) => ({
    timestamp: new Date(Date.UTC(2026, 9, 3, 0, 0, i)).toISOString(),
    type: "response_item",
    payload: {
      type: "message",
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: [{ type: i % 2 === 0 ? "input_text" : "output_text", text: i === 0 ? "EARLYCANARYZEBRA" : `synthetic history ${i}` }],
    },
  }));
  writeFileSync(file, [
    JSON.stringify({ type: "session_meta", payload: { id: "codex-synthetic-source", cwd: root } }),
    ...records.map((record) => JSON.stringify(record)),
  ].join("\n") + "\n");
  const result = await runSessionMigration({
    files: [file], dbPath, stateDir: root, apply: true,
    sourceFormat: "codex", sessionId, sessionKey,
  });
  expect(result.errorFiles).toBe(0);
  expect(result.importedMessages).toBe(300);
  const config = createTestConfig(dbPath);
  const engine = new LcmContextEngine({
    ...createTestDeps(config),
    readVisibleSessionTranscriptMessageEntries: async () => records.slice(-4).map((record, i) => ({
      entryId: `host-entry-${i}`, parentId: i === 0 ? "omitted-host-parent" : `host-entry-${i - 1}`,
      seq: i + 1, role: record.payload.role,
      message: { role: record.payload.role, content: record.payload.content[0]!.text },
      createdAt: record.timestamp,
    })),
  }, createLcmDatabaseConnection(dbPath));
  const store = engine.getConversationStore();
  const before = await store.getConversationForSession({ sessionId, sessionKey });
  expect(before).not.toBeNull();
  await engine.bootstrap({ sessionId, sessionKey, runtimeContext: {
    transcriptStorage: { kind: "sqlite" },
    sessionTarget: { agentId: "k", sessionId, sessionKey, storePath: join(root, "host.sqlite") },
  } });
  const after = await store.getConversationForSession({ sessionId, sessionKey });
  expect(after?.conversationId).toBe(before?.conversationId);
  expect(await store.getMessageCount(after!.conversationId)).toBe(300);
  await engine.ingest({ sessionId, sessionKey, message: { role: "user", content: "Continue the imported work" } });
  expect(await store.getMessageCount(after!.conversationId)).toBe(301);
  const matches = await store.searchMessages({ conversationId: after!.conversationId, mode: "full_text", query: "EARLYCANARYZEBRA" });
  expect(matches).toHaveLength(1);
  const reimport = await runSessionMigration({
    files: [file], dbPath, stateDir: root, apply: true,
    sourceFormat: "codex", sessionId, sessionKey,
  });
  expect(reimport.errorFiles).toBe(1);
  expect(reimport.files[0]?.reason).toBe("codex-destination-not-empty");
  expect(await store.getMessageCount(after!.conversationId)).toBe(301);
});

import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LcmConfig } from "../src/db/config.js";
import { closeLcmConnection, createLcmDatabaseConnection } from "../src/db/connection.js";
import { LcmContextEngine } from "../src/engine.js";
import type { LcmDependencies } from "../src/types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

function createTestConfig(databasePath: string): LcmConfig {
  return {
    enabled: true,
    databasePath,
    ignoreSessionPatterns: [],
    statelessSessionPatterns: [],
    skipStatelessSessions: true,
    contextThreshold: 0.75,
    freshTailCount: 8,
    newSessionRetainDepth: 2,
    leafMinFanout: 8,
    condensedMinFanout: 4,
    condensedMinFanoutHard: 2,
    incrementalMaxDepth: 0,
    leafChunkTokens: 20_000,
    leafTargetTokens: 600,
    condensedTargetTokens: 900,
    maxExpandTokens: 4000,
    largeFileTokenThreshold: 25_000,
    summaryProvider: "",
    summaryModel: "",
    largeFileSummaryProvider: "",
    largeFileSummaryModel: "",
    timezone: "UTC",
    pruneHeartbeatOk: false,
    transcriptGcEnabled: false,
    proactiveThresholdCompactionMode: "deferred",
    autoRotateSessionFiles: {
      enabled: true,
      sizeBytes: 2 * 1024 * 1024,
      startup: "rotate",
      runtime: "rotate",
    },
    summaryMaxOverageFactor: 3,
    customInstructions: "",
    expansionProvider: "",
    expansionModel: "",
    pinnedFiles: [],
    pinnedFilesPerAgent: {},
    circuitBreakerThreshold: 5,
    circuitBreakerCooldownMs: 1_800_000,
  };
}

function createTestDeps(config: LcmConfig): LcmDependencies {
  return {
    config,
    complete: vi.fn(async () => ({
      content: [{ type: "text", text: "summary output" }],
    })),
    callGateway: vi.fn(async () => ({})),
    resolveModel: vi.fn(() => ({ provider: "anthropic", model: "claude-opus-4-5" })),
    getApiKey: vi.fn(async () => "test-api-key"),
    requireApiKey: vi.fn(async () => "test-api-key"),
    parseAgentSessionKey: (key: string) => {
      const trimmed = key.trim();
      if (!trimmed.startsWith("agent:")) return null;
      const parts = trimmed.split(":");
      if (parts.length < 3) return null;
      return { agentId: parts[1] ?? "main", suffix: parts.slice(2).join(":") };
    },
    isSubagentSessionKey: (key: string) => key.includes(":subagent:"),
    normalizeAgentId: (id?: string) => (id?.trim() ? id : "main"),
    buildSubagentSystemPrompt: () => "subagent prompt",
    readLatestAssistantReply: (messages: unknown[]) => {
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const msg = messages[i] as { role?: unknown; content?: unknown };
        if (msg.role === "assistant" && typeof msg.content === "string") return msg.content;
      }
      return undefined;
    },
    resolveAgentDir: () => process.env.HOME ?? tmpdir(),
    resolveSessionIdFromSessionKey: async () => undefined,
    agentLaneSubagent: "subagent",
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
}

function createEngine(configOverrides?: Partial<LcmConfig>): LcmContextEngine {
  const tempDir = mkdtempSync(join(tmpdir(), "lcm-flood-skills-"));
  tempDirs.push(tempDir);
  const config = { ...createTestConfig(join(tempDir, "lcm.db")), ...configOverrides };
  const db = createLcmDatabaseConnection(config.databasePath);
  return new LcmContextEngine(createTestDeps(config), db);
}

function createSessionFilePath(name: string): string {
  const tempDir = mkdtempSync(join(tmpdir(), "lcm-flood-session-"));
  tempDirs.push(tempDir);
  return join(tempDir, `${name}.jsonl`);
}

/**
 * Build a JSONL session with `pairCount` user/assistant message pairs.
 * Every 5th pair uses identical "ping"/"pong" content to stress
 * content-based identity matching in reconcileSessionTail.
 */
function buildRepeatedPatternSession(sessionFile: string, pairCount: number): void {
  const sm = SessionManager.open(sessionFile);
  for (let i = 0; i < pairCount; i++) {
    if (i % 5 === 0) {
      sm.appendMessage({
        role: "user",
        content: [{ type: "text", text: "ping" }],
      } as AgentMessage);
      sm.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "pong" }],
      } as AgentMessage);
    } else {
      sm.appendMessage({
        role: "user",
        content: [{ type: "text", text: `Question ${i}` }],
      } as AgentMessage);
      sm.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: `Answer ${i}` }],
      } as AgentMessage);
    }
  }
}

/**
 * Simulate what maintain() does after rewriteTranscriptEntries succeeds:
 * rewrite a portion of the JSONL file (shrinking tool outputs) and update
 * the bootstrap checkpoint to match the new file state.
 *
 * This directly exercises the PR #280 fix code path without needing
 * summarized tool messages as GC candidates.
 */
async function simulateMaintainRewrite(
  engine: LcmContextEngine,
  conversationId: number,
  sessionFile: string,
  shrinkCount: number,
): Promise<void> {
  const originalContent = readFileSync(sessionFile, "utf8");
  const lines = originalContent.trimEnd().split("\n");

  // Shrink the last `shrinkCount` message lines
  const start = Math.max(0, lines.length - shrinkCount);
  for (let i = start; i < lines.length; i++) {
    try {
      const parsed = JSON.parse(lines[i]!);
      if (parsed.role && parsed.content) {
        if (typeof parsed.content === "string") {
          parsed.content = `[shrunk] ${parsed.content}`;
        } else if (Array.isArray(parsed.content)) {
          parsed.content = parsed.content.map((block: Record<string, unknown>) =>
            block.type === "text" ? { ...block, text: `[shrunk] ${block.text}` } : block,
          );
        }
        lines[i] = JSON.stringify(parsed);
      }
    } catch {
      // Skip non-JSON lines
    }
  }

  writeFileSync(sessionFile, lines.join("\n") + "\n", "utf8");

  // Update checkpoint — exactly what maintain() does at engine.ts:2466-2483
  const newStats = statSync(sessionFile);
  const lastLine = lines[lines.length - 1]!;
  const lastMsg = JSON.parse(lastLine);
  const role = lastMsg.role ?? "";
  const content =
    typeof lastMsg.content === "string"
      ? lastMsg.content
      : Array.isArray(lastMsg.content)
        ? lastMsg.content
            .filter((b: Record<string, unknown>) => b.type === "text")
            .map((b: Record<string, unknown>) => b.text)
            .join("")
        : "";
  const entryHash = createHash("sha256")
    .update(JSON.stringify({ role, content }))
    .digest("hex");

  await engine.getSummaryStore().upsertConversationBootstrapState({
    conversationId,
    sessionFilePath: sessionFile,
    lastSeenSize: newStats.size,
    lastSeenMtimeMs: Math.trunc(newStats.mtimeMs),
    lastProcessedOffset: newStats.size,
    lastProcessedEntryHash: entryHash,
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("bootstrap flood regression (PR #280) — round-trip integration", () => {
  afterEach(() => {
    closeLcmConnection();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bootstrap imports 0 messages after maintain rewrites JSONL and updates checkpoint", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();
    const sessionFile = createSessionFilePath("flood-roundtrip");

    // Step 1: Create conversation with ~100 messages (50 pairs, repeated patterns)
    buildRepeatedPatternSession(sessionFile, 50);

    // Step 2: Initial bootstrap — seeds DB with messages
    const boot1 = await engine.bootstrap({ sessionId, sessionFile });
    expect(boot1.bootstrapped, "first bootstrap should seed the DB").toBe(true);
    expect(boot1.importedMessages, "first bootstrap should import messages").toBeGreaterThan(0);

    const conversation = await engine
      .getConversationStore()
      .getConversationBySessionId(sessionId);
    expect(conversation, "conversation should exist after bootstrap").not.toBeNull();
    const conversationId = conversation!.conversationId;
    const dbCountAfterBoot = await engine
      .getConversationStore()
      .getMessageCount(conversationId);

    // Step 3: Simulate maintain() — rewrite JSONL (shrink last 35 messages)
    // and update checkpoint (the PR #280 fix)
    await simulateMaintainRewrite(engine, conversationId, sessionFile, 35);

    // Step 4: Simulate gateway restart — bootstrap again
    const reconcileSpy = vi.spyOn(engine as any, "reconcileSessionTail");
    const boot2 = await engine.bootstrap({ sessionId, sessionFile });

    // Assert: 0 messages re-imported because checkpoint was updated by maintain
    expect(
      boot2.importedMessages,
      "second bootstrap should import 0 messages — checkpoint is current after maintain",
    ).toBe(0);

    // reconcileSessionTail should NOT be called — checkpoint fast-path should kick in
    expect(
      reconcileSpy,
      "reconcileSessionTail should not be called when checkpoint matches post-rewrite state",
    ).not.toHaveBeenCalled();

    // Step 5: Assert no duplicate messages in DB
    const dbCountAfterReboot = await engine
      .getConversationStore()
      .getMessageCount(conversationId);
    expect(
      dbCountAfterReboot,
      "message count should not increase after second bootstrap",
    ).toBe(dbCountAfterBoot);
  });

  it("import cap fires when checkpoint is stale (corrupt mtime), blocking the flood", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();
    const sessionFile = createSessionFilePath("flood-stale-cap");

    // Create session with 50 pairs (100 messages)
    buildRepeatedPatternSession(sessionFile, 50);

    // Bootstrap to seed DB
    const boot1 = await engine.bootstrap({ sessionId, sessionFile });
    expect(boot1.bootstrapped, "first bootstrap should succeed").toBe(true);
    expect(boot1.importedMessages, "should import messages on first bootstrap").toBeGreaterThan(0);

    const conversation = await engine
      .getConversationStore()
      .getConversationBySessionId(sessionId);
    expect(conversation, "conversation should exist").not.toBeNull();
    const conversationId = conversation!.conversationId;
    const dbCountAfterBoot = await engine
      .getConversationStore()
      .getMessageCount(conversationId);

    // Corrupt the checkpoint: set stale mtime/size so it no longer matches
    // This simulates what happens WITHOUT the PR #280 fix — maintain() changes
    // the JSONL but doesn't update the checkpoint
    const fileStats = statSync(sessionFile);
    await engine.getSummaryStore().upsertConversationBootstrapState({
      conversationId,
      sessionFilePath: sessionFile,
      lastSeenSize: fileStats.size - 100,
      lastSeenMtimeMs: Math.trunc(fileStats.mtimeMs) - 5000,
      lastProcessedOffset: fileStats.size - 100,
      lastProcessedEntryHash: "0000000000000000000000000000000000000000000000000000000000000000",
    });

    // Add many new messages to the JSONL — these look "new" due to stale checkpoint
    const sm = SessionManager.open(sessionFile);
    for (let i = 0; i < 200; i++) {
      sm.appendMessage({
        role: "user",
        content: [{ type: "text", text: `extra flood message ${i}` }],
      } as AgentMessage);
    }

    // Bootstrap again — should hit import cap because reconcileSessionTail
    // would try to import more than max(existingDbCount * 0.2, 50) messages
    const boot2 = await engine.bootstrap({ sessionId, sessionFile });

    expect(
      boot2.reason,
      "should report import cap was hit",
    ).toBe("reconcile import capped");
    expect(
      boot2.importedMessages,
      "should import 0 messages when cap fires",
    ).toBe(0);

    // Verify no new messages were added to DB
    const dbCountAfterFlood = await engine
      .getConversationStore()
      .getMessageCount(conversationId);
    expect(
      dbCountAfterFlood,
      "DB message count should not change after capped import",
    ).toBe(dbCountAfterBoot);
  });

  it("no duplicate messages or seq numbers after bootstrap-maintain-bootstrap cycle", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();
    const sessionFile = createSessionFilePath("flood-no-dupes");

    buildRepeatedPatternSession(sessionFile, 50);

    // Bootstrap
    const boot1 = await engine.bootstrap({ sessionId, sessionFile });
    expect(boot1.importedMessages, "initial bootstrap should import messages").toBeGreaterThan(0);

    const conversation = await engine
      .getConversationStore()
      .getConversationBySessionId(sessionId);
    expect(conversation, "conversation should exist").not.toBeNull();
    const conversationId = conversation!.conversationId;

    // Snapshot messages before the rewrite
    const messagesBefore = await engine.getConversationStore().getMessages(conversationId);

    // Simulate maintain() rewrite + checkpoint update
    await simulateMaintainRewrite(engine, conversationId, sessionFile, 20);

    // Re-bootstrap
    const boot2 = await engine.bootstrap({ sessionId, sessionFile });
    expect(boot2.importedMessages, "no re-import after maintain checkpoint update").toBe(0);

    // Verify exact same messages — no duplicates, no new entries
    const messagesAfter = await engine.getConversationStore().getMessages(conversationId);
    expect(
      messagesAfter.length,
      "message count should be identical after re-bootstrap",
    ).toBe(messagesBefore.length);

    // Verify content set is unchanged
    const contentSetBefore = new Set(messagesBefore.map((m) => `${m.role}:${m.content}`));
    const contentSetAfter = new Set(messagesAfter.map((m) => `${m.role}:${m.content}`));
    expect(
      contentSetAfter,
      "message content set should be identical — no duplicates introduced",
    ).toEqual(contentSetBefore);

    // Verify no duplicate seq numbers
    const seqNumbers = messagesAfter.map((m) => m.seq);
    const uniqueSeqs = new Set(seqNumbers);
    expect(
      uniqueSeqs.size,
      "all seq numbers should be unique — no duplicate rows",
    ).toBe(seqNumbers.length);
  });

  it("both fixes work together: maintain updates checkpoint AND cap protects against stale state", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();
    const sessionFile = createSessionFilePath("flood-combined");

    buildRepeatedPatternSession(sessionFile, 50);

    // Phase 1: Bootstrap
    const boot1 = await engine.bootstrap({ sessionId, sessionFile });
    expect(boot1.bootstrapped, "initial bootstrap should succeed").toBe(true);

    const conversation = await engine
      .getConversationStore()
      .getConversationBySessionId(sessionId);
    expect(conversation, "conversation should exist").not.toBeNull();
    const conversationId = conversation!.conversationId;
    const dbCountAfterBoot = await engine
      .getConversationStore()
      .getMessageCount(conversationId);

    // Phase 2: Simulate maintain() with correct checkpoint update (PR #280 fix)
    await simulateMaintainRewrite(engine, conversationId, sessionFile, 25);

    // Phase 2b: Re-bootstrap — should be a no-op (checkpoint matches)
    const boot2 = await engine.bootstrap({ sessionId, sessionFile });
    expect(boot2.importedMessages, "no imports after maintain with good checkpoint").toBe(0);

    // Phase 3: Now simulate failure — corrupt the checkpoint
    await engine.getSummaryStore().upsertConversationBootstrapState({
      conversationId,
      sessionFilePath: sessionFile,
      lastSeenSize: 1,
      lastSeenMtimeMs: 0,
      lastProcessedOffset: 1,
      lastProcessedEntryHash: "bad_hash",
    });

    // Add enough extra messages to trigger the import cap
    const sm = SessionManager.open(sessionFile);
    for (let i = 0; i < 200; i++) {
      sm.appendMessage({
        role: "user",
        content: [{ type: "text", text: `flood ${i}` }],
      } as AgentMessage);
    }

    // Phase 4: Bootstrap with stale checkpoint — import cap should block
    const boot3 = await engine.bootstrap({ sessionId, sessionFile });
    expect(boot3.reason, "cap should fire with stale checkpoint").toBe("reconcile import capped");
    expect(boot3.importedMessages, "no messages imported when capped").toBe(0);

    // DB unchanged throughout
    const finalCount = await engine.getConversationStore().getMessageCount(conversationId);
    expect(
      finalCount,
      "DB message count should be unchanged after capped flood attempt",
    ).toBe(dbCountAfterBoot);
  });
});

/**
 * Regression test for false-positive in assertNoReplayTimestampFlood.
 *
 * Bug: The anti-replay guard in conversation-store throws
 *   `[lcm] refused replay-like message batch: ... replicatedRows>=3`
 * when 3+ messages with identical (conversation_id, role, content, created_at-in-seconds)
 * are ingested. SQLite's `datetime('now')` has only second-level granularity, so any
 * burst of identical tool/assistant outputs within the same second trips the guard.
 *
 * Real-world trigger: cron-driven sub-agent making many quick tool calls that
 * return identical idempotent responses (e.g. {"status":"ok"} from a maintenance
 * job processing N items). The legitimate burst is misclassified as a replay attack,
 * aborting ingest, which in turn skips compaction and fails reconcile.
 *
 * Fix (Opção D — role-aware threshold): replay attacks rebroadcast EXTERNAL input
 * (role=user). System-internal outputs (role=tool|assistant|system) are generated
 * by the runtime itself, not rebroadcastable. Distinguish:
 *   - role=user: threshold 3 (preserves current defense against webhook/input replay)
 *   - role=tool|assistant|system: threshold raised to a configurable value
 *     (default high enough to absorb legitimate sub-agent bursts)
 *
 * Schema constraint: messages table has UNIQUE(conversation_id, seq) only.
 * There is NO unique index on (role, content, created_at), so the guard is
 * the sole anti-replay protection. Relaxing it for internal roles is a
 * deliberate trade-off documented in the PR.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LcmConfig } from "../src/db/config.js";
import { closeLcmConnection, createLcmDatabaseConnection } from "../src/db/connection.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { LcmContextEngine } from "../src/engine.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import type { CreateMessageInput, MessageRole } from "../src/store/conversation-store.js";
import { createTestConfig, createTestDeps as createSharedTestDeps } from "./helpers.js";

let __seqCounter = 0;
function msg(
  conversationId: number,
  role: MessageRole,
  content: string,
): CreateMessageInput {
  __seqCounter += 1;
  return { conversationId, seq: __seqCounter, role, content, tokenCount: 1 };
}

/**
 * Wait long enough that the next SQLite `datetime('now')` call returns the
 * next second. The guard's priorCount uses `prior.created_at < input.createdAt`
 * (strict), so a seed and a follow-up batch landing in the same SQLite-second
 * would yield priorCount=0 and the guard would never fire. Tests that exercise
 * the guard need a clean second boundary between seed and trigger.
 */
async function waitForNextSqliteSecond(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1100));
}
import type { LcmDependencies } from "../src/types.js";

const tempDirs: string[] = [];


function createTestDeps(config: LcmConfig): LcmDependencies {
  return createSharedTestDeps(config, {
    complete: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
    readLatestAssistantReply: () => undefined,
  });
}

function createEngine(configOverrides?: Partial<LcmConfig>): LcmContextEngine {
  const dir = mkdtempSync(join(tmpdir(), "lcm-replay-burst-"));
  tempDirs.push(dir);
  const config = { ...createTestConfig(join(dir, "lcm.db")), ...configOverrides };
  const db = createLcmDatabaseConnection(config.databasePath);
  return new LcmContextEngine(createTestDeps(config), db);
}

async function ensureConversation(
  engine: LcmContextEngine,
  sessionId: string,
  sessionKey: string,
): Promise<number> {
  // Trigger conversation creation via a single trivial ingest.
  await engine.ingestBatch({
    sessionId,
    sessionKey,
    messages: [{ role: "user", content: `bootstrap ${randomUUID()}` } as AgentMessage],
    isHeartbeat: false,
  });
  const convo = await engine.getConversationStore().getConversationBySessionId(sessionId);
  if (!convo) throw new Error("conversation not created");
  return convo.conversationId;
}

describe("anti-replay false-positive regression — legitimate sub-agent burst", () => {
  afterEach(() => {
    closeLcmConnection();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it(
    "ingests sub-agent burst of identical TOOL results across successive batches without throwing",
    async () => {
      const engine = createEngine();
      const sessionId = randomUUID();
      const sessionKey = `agent:test:cron:job-${randomUUID()}:run:${sessionId}`;
      await ensureConversation(engine, sessionId, sessionKey);

      // Real-prod shape (conv 3790 / gbrain-maintain-orphans-daily):
      // sub-agent emits identical tool results across many afterTurn batches
      // landing within the same SQLite `datetime('now')` second.
      //
      // Batch 1: 3 identical tool messages commit at second T.
      // Batch 2: 3 more identical tool messages commit at second T+1.
      // Pre-fix: assertNoReplayTimestampFlood throws on batch 2 because
      //   priorCount=3 + candidateCount=3 = 6 >= threshold 3.
      // Post-fix (role-aware): tool role gets a higher threshold (default 32),
      //   absorbing legitimate idempotent retries.
      const payload = '{"status": "ok"}';
      const mkBatch = (): AgentMessage[] => [
        { role: "tool", content: payload } as unknown as AgentMessage,
        { role: "tool", content: payload } as unknown as AgentMessage,
        { role: "tool", content: payload } as unknown as AgentMessage,
      ];

      await engine.ingestBatch({
        sessionId,
        sessionKey,
        messages: mkBatch(),
        isHeartbeat: false,
      });

      await waitForNextSqliteSecond();

      await expect(
        engine.ingestBatch({
          sessionId,
          sessionKey,
          messages: mkBatch(),
          isHeartbeat: false,
        }),
        "second batch of identical tool results must not be flagged as replay attack",
      ).resolves.not.toThrow();
    },
  );

  // Unit-level tests against ConversationStore directly. The engine layer
  // applies dedup/transcript-reconcile before reaching the guard, which makes
  // end-to-end repros for the USER replay path non-deterministic; the
  // assertNoReplayTimestampFlood guard is the unit under test and is
  // exercised here without that upstream pipeline.

  it(
    "[unit] role-aware guard: USER replay flood (defense preserved) \u2014 throws at threshold 3",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "lcm-replay-burst-unit-"));
      tempDirs.push(dir);
      const db = createLcmDatabaseConnection(join(dir, "lcm.db"));
      runLcmMigrations(db);
      const store = new ConversationStore(db, {
        replayFloodThresholdExternal: 3,
        replayFloodThresholdInternal: 32,
      });

      const convo = await store.createConversation({
        sessionId: randomUUID(),
        sessionKey: "agent:test:webhook:unit",
      });

      const payload = "/replay_attack_payload";
      // Seed 1 prior identical user message (so subsequent identical ones get priorCount>0).
      await store.createMessagesBulk([msg(convo.conversationId, "user", payload)]);
      await waitForNextSqliteSecond();

      // Second batch with 3 identical user messages at the same SQLite second.
      // candidateCount=3 → replicatedCount=3 ≥ threshold 3 → must throw.
      await expect(
        store.createMessagesBulk([
          msg(convo.conversationId, "user", payload),
          msg(convo.conversationId, "user", payload),
          msg(convo.conversationId, "user", payload),
        ]),
        "flood of 3 identical user messages after prior replica must be refused",
      ).rejects.toThrow(/refused replay-like/);
    },
  );

  it(
    "[unit] role-aware guard: distinct USER replay contents share external threshold bucket",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "lcm-replay-burst-unit-"));
      tempDirs.push(dir);
      const db = createLcmDatabaseConnection(join(dir, "lcm.db"));
      runLcmMigrations(db);
      const store = new ConversationStore(db, {
        replayFloodThresholdExternal: 3,
        replayFloodThresholdInternal: 32,
      });

      const convo = await store.createConversation({
        sessionId: randomUUID(),
        sessionKey: "agent:test:webhook:distinct-user-replays",
      });
      const payloads = ["/cmd one", "/cmd two", "/cmd three"];

      await store.createMessagesBulk(
        payloads.map((payload) => msg(convo.conversationId, "user", payload)),
      );
      await waitForNextSqliteSecond();

      await expect(
        store.createMessagesBulk(
          payloads.map((payload) => msg(convo.conversationId, "user", payload)),
        ),
      ).rejects.toThrow(/role=user/);
    },
  );

  it(
    "[unit] role-aware guard: TOOL burst of 10 identical results does NOT throw",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "lcm-replay-burst-unit-"));
      tempDirs.push(dir);
      const db = createLcmDatabaseConnection(join(dir, "lcm.db"));
      runLcmMigrations(db);
      const store = new ConversationStore(db, {
        replayFloodThresholdExternal: 3,
        replayFloodThresholdInternal: 32,
      });

      const convo = await store.createConversation({
        sessionId: randomUUID(),
        sessionKey: "agent:test:cron:unit",
      });

      // Seed batch: 5 identical tool results (allowed under default 32).
      await store.createMessagesBulk(
        Array.from({ length: 5 }, () =>
          msg(convo.conversationId, "tool", '{"status": "ok"}'),
        ),
      );

      await waitForNextSqliteSecond();

      // Follow-up batch: 5 more identical tool results at the next SQLite second.
      // Pre-fix: 5 prior + 5 candidate → throws at legacy threshold 3.
      // Post-fix: 10 ≤ 32 → no throw.
      await expect(
        store.createMessagesBulk(
          Array.from({ length: 5 }, () =>
            msg(convo.conversationId, "tool", '{"status": "ok"}'),
          ),
        ),
      ).resolves.toBeDefined();
    },
  );

  it(
    "[unit] role-aware guard: distinct TOOL replay contents do not share a threshold bucket",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "lcm-replay-burst-unit-"));
      tempDirs.push(dir);
      const db = createLcmDatabaseConnection(join(dir, "lcm.db"));
      runLcmMigrations(db);
      const store = new ConversationStore(db, {
        replayFloodThresholdExternal: 3,
        replayFloodThresholdInternal: 6,
      });

      const convo = await store.createConversation({
        sessionId: randomUUID(),
        sessionKey: "agent:test:cron:distinct-tool-results",
      });
      const payloads = Array.from(
        { length: 6 },
        (_, index) => `{"status":"ok","item":${index}}`,
      );

      await store.createMessagesBulk(
        payloads.map((payload) => msg(convo.conversationId, "tool", payload)),
      );
      await waitForNextSqliteSecond();

      await expect(
        store.createMessagesBulk(
          payloads.map((payload) => msg(convo.conversationId, "tool", payload)),
        ),
      ).resolves.toBeDefined();
    },
  );

  it(
    "[unit] role-aware guard: mixed ASSISTANT and TOOL internal bursts do NOT throw",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "lcm-replay-burst-unit-"));
      tempDirs.push(dir);
      const db = createLcmDatabaseConnection(join(dir, "lcm.db"));
      runLcmMigrations(db);
      const store = new ConversationStore(db, {
        replayFloodThresholdExternal: 3,
        replayFloodThresholdInternal: 32,
      });

      const convo = await store.createConversation({
        sessionId: randomUUID(),
        sessionKey: "agent:test:cron:mixed-internal",
      });

      const toolPayload = '{"status": "ok"}';
      const assistantPayload = "maintenance step completed";
      await store.createMessagesBulk([
        msg(convo.conversationId, "assistant", assistantPayload),
        msg(convo.conversationId, "assistant", assistantPayload),
        msg(convo.conversationId, "tool", toolPayload),
        msg(convo.conversationId, "tool", toolPayload),
      ]);

      await waitForNextSqliteSecond();

      await expect(
        store.createMessagesBulk([
          msg(convo.conversationId, "assistant", assistantPayload),
          msg(convo.conversationId, "assistant", assistantPayload),
          msg(convo.conversationId, "assistant", assistantPayload),
          msg(convo.conversationId, "tool", toolPayload),
          msg(convo.conversationId, "tool", toolPayload),
          msg(convo.conversationId, "tool", toolPayload),
        ]),
      ).resolves.toBeDefined();
    },
  );

  it(
    "[unit] role-aware guard: TOOL burst still bounded by replayFloodThresholdInternal",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "lcm-replay-burst-unit-"));
      tempDirs.push(dir);
      const db = createLcmDatabaseConnection(join(dir, "lcm.db"));
      runLcmMigrations(db);
      // Tight internal ceiling to verify the ceiling actually fires.
      const store = new ConversationStore(db, {
        replayFloodThresholdExternal: 3,
        replayFloodThresholdInternal: 6,
      });

      const convo = await store.createConversation({
        sessionId: randomUUID(),
        sessionKey: "agent:test:cron:unit-ceiling",
      });

      const payload = '{"status": "ok"}';
      await store.createMessagesBulk(
        Array.from({ length: 5 }, () => msg(convo.conversationId, "tool", payload)),
      );
      await waitForNextSqliteSecond();

      // Need candidateCount>=6 in a single batch to trip the per-batch guard.
      // (Engine's afterTurn never sends 6 identical tool msgs in one batch in
      //  practice; this verifies the configured ceiling does fire when
      //  pathologically large bursts arrive.)
      await expect(
        store.createMessagesBulk(
          Array.from({ length: 6 }, () => msg(convo.conversationId, "tool", payload)),
        ),
      ).rejects.toThrow(/refused replay-like/);
    },
  );

  it(
    "[unit] role-aware guard: USER and TOOL floods at same second are tracked independently",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "lcm-replay-burst-unit-"));
      tempDirs.push(dir);
      const db = createLcmDatabaseConnection(join(dir, "lcm.db"));
      runLcmMigrations(db);
      const store = new ConversationStore(db, {
        replayFloodThresholdExternal: 3,
        replayFloodThresholdInternal: 32,
      });

      const convo = await store.createConversation({
        sessionId: randomUUID(),
        sessionKey: "agent:test:mixed:unit",
      });

      // Seed: 10 identical tool results (well under internal threshold).
      await store.createMessagesBulk(
        Array.from({ length: 10 }, () =>
          msg(convo.conversationId, "tool", '{"status": "ok"}'),
        ),
      );

      // Seed 1 prior identical user message so subsequent ones see priorCount>0.
      await store.createMessagesBulk([msg(convo.conversationId, "user", "/cmd")]);
      await waitForNextSqliteSecond();

      // Now flood 3 identical user messages — must trip role=user threshold
      // even though tool flood (10) is much larger; per-role tracking.
      await expect(
        store.createMessagesBulk([
          msg(convo.conversationId, "user", "/cmd"),
          msg(convo.conversationId, "user", "/cmd"),
          msg(convo.conversationId, "user", "/cmd"),
        ]),
      ).rejects.toThrow(/role=user/);
    },
  );
});

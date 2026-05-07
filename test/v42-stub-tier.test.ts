import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runLcmMigrations } from "../src/db/migration.js";
import { ContextAssembler } from "../src/assembler.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { SummaryStore } from "../src/store/summary-store.js";

/**
 * v4.2 §B — stub-tier stratification end-to-end behavior tests.
 *
 * These exercise the assembler's stub-emit pass against real on-disk
 * DB state (in-memory SQLite, no LLM/network), proving the contract:
 *
 *  1. With `stubLargeToolPayloads=false`, behavior is identical to v4.1.
 *  2. With `stubLargeToolPayloads=true`, evictable tool messages whose
 *     row carries a non-null `large_content` sidecar are replaced with
 *     a compact stub before the budget pass.
 *  3. Fresh-tail tool messages are NEVER stubbed regardless of flag.
 *  4. Tool messages without large_content are NEVER stubbed (legacy
 *     rows untouched).
 *  5. Token estimate drops by approximately the elision delta.
 */

interface SeedToolMsg {
  toolCallId: string;
  toolName: string;
  payload: string;
  large?: boolean;
}

function seedConversation(
  db: DatabaseSync,
  toolMessages: SeedToolMsg[],
): { conversationId: number } {
  // Create one conversation with: a leading user message, then alternating
  // assistant tool_use + tool result for each entry. The most-recent N
  // messages will land in the fresh tail; older ones are evictable.
  const convRow = db
    .prepare(
      `INSERT INTO conversations (session_id, session_key, active) VALUES (?, ?, 1) RETURNING conversation_id`,
    )
    .get("test-session", "agent:main:main") as { conversation_id: number };
  const conversationId = convRow.conversation_id;

  let seq = 1;
  // Initial user prompt.
  db.prepare(
    `INSERT INTO messages (conversation_id, seq, role, content, token_count) VALUES (?, ?, 'user', ?, ?)`,
  ).run(conversationId, seq++, "kick off the work", 4);
  db.prepare(
    `INSERT INTO context_items (conversation_id, ordinal, item_type, message_id) VALUES (?, ?, 'message', last_insert_rowid())`,
  ).run(conversationId, seq);

  for (const tm of toolMessages) {
    // assistant tool_use
    const assistantContent = JSON.stringify([
      { type: "tool_use", id: tm.toolCallId, name: tm.toolName, input: { q: "x" } },
    ]);
    const aRes = db
      .prepare(
        `INSERT INTO messages (conversation_id, seq, role, content, token_count) VALUES (?, ?, 'assistant', ?, ?) RETURNING message_id`,
      )
      .get(conversationId, seq++, assistantContent, 6) as { message_id: number };
    db.prepare(
      `INSERT INTO message_parts (part_id, message_id, session_id, part_type, ordinal, tool_call_id, tool_name, tool_input)
       VALUES (?, ?, ?, 'tool', 0, ?, ?, ?)`,
    ).run(
      `p-${aRes.message_id}-tu`,
      aRes.message_id,
      "test-session",
      tm.toolCallId,
      tm.toolName,
      JSON.stringify({ q: "x" }),
    );
    db.prepare(
      `INSERT INTO context_items (conversation_id, ordinal, item_type, message_id) VALUES (?, ?, 'message', ?)`,
    ).run(conversationId, seq, aRes.message_id);

    // tool result with corresponding tool_call_id, optionally with large_content.
    const tokenCount = Math.max(1, Math.ceil(tm.payload.length / 4));
    const tRes = db
      .prepare(
        `INSERT INTO messages (conversation_id, seq, role, content, token_count, large_content)
         VALUES (?, ?, 'tool', ?, ?, ?) RETURNING message_id`,
      )
      .get(
        conversationId,
        seq++,
        tm.payload,
        tokenCount,
        tm.large ? tm.payload : null,
      ) as { message_id: number };
    // metadata.originalRole='toolResult' is required for the assembler's
    // toRuntimeRole() to recognize this part as a tool_result rather than
    // a tool_use (the same row encodes both forms).
    db.prepare(
      `INSERT INTO message_parts (part_id, message_id, session_id, part_type, ordinal, tool_call_id, tool_name, tool_output, metadata)
       VALUES (?, ?, ?, 'tool', 0, ?, ?, ?, ?)`,
    ).run(
      `p-${tRes.message_id}-tr`,
      tRes.message_id,
      "test-session",
      tm.toolCallId,
      tm.toolName,
      tm.payload,
      JSON.stringify({ originalRole: "toolResult", rawType: "tool_result" }),
    );
    db.prepare(
      `INSERT INTO context_items (conversation_id, ordinal, item_type, message_id) VALUES (?, ?, 'message', ?)`,
    ).run(conversationId, seq, tRes.message_id);
  }
  return { conversationId };
}

function bigPayload(prefix: string, kb: number): string {
  return `${prefix}\n` + "x".repeat(kb * 1024);
}

describe("v4.2 §B stub-tier stratification", () => {
  it("emits stubs only for evictable tool messages with large_content set", async () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false, seedDefaultPrompts: false });

    // 6 tool turns: 3 large in the evictable region, 2 small (never stubbable),
    // 1 large at the end which the fresh-tail captures.
    seedConversation(db, [
      { toolCallId: "call-1", toolName: "Read", payload: bigPayload("R1", 16), large: true },
      { toolCallId: "call-2", toolName: "Read", payload: "small ack", large: false },
      { toolCallId: "call-3", toolName: "Bash", payload: bigPayload("B3", 32), large: true },
      { toolCallId: "call-4", toolName: "Edit", payload: "ok", large: false },
      { toolCallId: "call-5", toolName: "Grep", payload: bigPayload("G5", 8), large: true },
      // Final entry — will land in the fresh tail (freshTailCount=2 below).
      { toolCallId: "call-6", toolName: "Read", payload: bigPayload("R6", 24), large: true },
    ]);

    const conversationStore = new ConversationStore(db);
    const summaryStore = new SummaryStore(db);
    const assembler = new ContextAssembler(conversationStore, summaryStore, "UTC");

    const baseline = await assembler.assemble({
      conversationId: 1,
      tokenBudget: 200_000,
      freshTailCount: 2,
      stubLargeToolPayloads: false,
    });
    const stubbed = await assembler.assemble({
      conversationId: 1,
      tokenBudget: 200_000,
      freshTailCount: 2,
      stubLargeToolPayloads: true,
    });

    // Baseline does not stub anything.
    expect(baseline.debug?.stubStats?.stubbedCount ?? 0).toBe(0);

    // Stubbed run: 3 evictable large tool messages should be stubbed
    // (the 4th large message is in the fresh tail). Small results are
    // ineligible (no large_content). The 5KB stub bound covers the
    // legible-stub range.
    const stats = stubbed.debug?.stubStats;
    expect(stats).toBeDefined();
    expect(stats!.stubbedCount).toBe(3);
    expect(stats!.tokensSaved).toBeGreaterThan(0);

    // The stubbed assembly should be materially smaller in tokens.
    expect(stubbed.estimatedTokens).toBeLessThan(baseline.estimatedTokens);
    expect(baseline.estimatedTokens - stubbed.estimatedTokens).toBeGreaterThan(
      0.5 * stats!.tokensSaved,
    );
  });

  it("preserves tool_use ↔ tool_result pairing when stubbing", async () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false, seedDefaultPrompts: false });
    seedConversation(db, [
      { toolCallId: "id-A", toolName: "Read", payload: bigPayload("A", 12), large: true },
      { toolCallId: "id-B", toolName: "Read", payload: bigPayload("B", 12), large: true },
      // Fresh tail — never stubbed.
      { toolCallId: "id-C", toolName: "Read", payload: bigPayload("C", 12), large: true },
    ]);

    const conversationStore = new ConversationStore(db);
    const summaryStore = new SummaryStore(db);
    const assembler = new ContextAssembler(conversationStore, summaryStore, "UTC");

    const out = await assembler.assemble({
      conversationId: 1,
      tokenBudget: 200_000,
      freshTailCount: 2,
      stubLargeToolPayloads: true,
    });

    // Walk through assembled messages — each tool_use must have a
    // matching tool_result (stubbed or not), so pairing survived.
    const toolUses = new Set<string>();
    const toolResults = new Set<string>();
    for (const msg of out.messages) {
      if ((msg as { role?: string }).role === "assistant") {
        const content = (msg as { content?: unknown }).content;
        if (Array.isArray(content)) {
          for (const block of content) {
            const rec = block as { type?: string; id?: string };
            if (rec?.type === "tool_use" && rec.id) toolUses.add(rec.id);
          }
        }
      }
      if ((msg as { role?: string }).role === "toolResult") {
        const id = (msg as { toolCallId?: string }).toolCallId;
        if (id) toolResults.add(id);
      }
    }
    // Pairing assertion: every assistant tool_use had a matching tool_result.
    for (const id of toolUses) {
      expect(toolResults.has(id)).toBe(true);
    }
  });

  it("never stubs tool messages without large_content (legacy rows)", async () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false, seedDefaultPrompts: false });
    // All small / unmigrated — no large_content anywhere.
    seedConversation(db, [
      { toolCallId: "x", toolName: "Bash", payload: bigPayload("X", 8), large: false },
      { toolCallId: "y", toolName: "Bash", payload: bigPayload("Y", 8), large: false },
      { toolCallId: "z", toolName: "Bash", payload: bigPayload("Z", 8), large: false },
    ]);

    const conversationStore = new ConversationStore(db);
    const summaryStore = new SummaryStore(db);
    const assembler = new ContextAssembler(conversationStore, summaryStore, "UTC");

    const out = await assembler.assemble({
      conversationId: 1,
      tokenBudget: 200_000,
      freshTailCount: 1,
      stubLargeToolPayloads: true,
    });
    expect(out.debug?.stubStats?.stubbedCount ?? 0).toBe(0);
    expect(out.debug?.stubStats?.tokensSaved ?? 0).toBe(0);
  });
});

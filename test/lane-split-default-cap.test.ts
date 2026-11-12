// Lane split — default conversation-lane cap regression.
//
// Background (measured 2026-10-13 on a real lcm.db copy): the old default was a
// fixed absolute cap (65536). At large budgets it slipped BELOW the conversation
// pool and started trimming the only lane that carries human text, so lane split
// did the opposite of its purpose. The main session at a 118k/150k budget kept
// 53.2% of the unbounded human text with lane split off, but only 37.5% with
// lane split on and the fixed cap.
//
// These tests pin the fix: when no explicit cap is configured it must be derived
// from the assembly budget (85% of the budget, see
// DEFAULT_CONVERSATION_LANE_BUDGET_RATIO), so a budget clearly larger than the
// conversation pool keeps the human text and lets the machine-load (tool) lane
// absorb the eviction instead.
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_CONVERSATION_LANE_BUDGET_RATIO,
  deriveConversationLaneTokenCap,
} from "../src/lane-split.js";
import { ContextAssembler } from "../src/assembler.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { SummaryStore } from "../src/store/summary-store.js";
import { runLcmMigrations } from "../src/db/migration.js";

const SESSION_ID = "lane-default-cap";

/** CJK-heavy filler: estimateTokens counts ~1.5 tokens/CJK char (4x ASCII). */
const CJK_UNIT = "上下文预算车道拆分人类文本保留率回归测试";
function bigCjk(chars: number): string {
  return CJK_UNIT.repeat(Math.ceil(chars / CJK_UNIT.length)).slice(0, chars);
}

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  runLcmMigrations(db, { fts5Available: false });
  return db;
}

type Seeded = { conversationId: number; markers: string[] };

/**
 * Seed a conversation whose evictable conversation pool is large (well over the
 * old fixed 65536 cap) plus a machine-load (tool-result) lane, so the two lanes
 * actually compete for the budget.
 */
function seedLargeConversation(
  db: DatabaseSync,
  opts: { turns: number; conversationChars: number; toolResults: number; toolChars: number },
): Seeded {
  const conv = db
    .prepare("INSERT INTO conversations (session_id, session_key, active) VALUES (?, ?, 1) RETURNING conversation_id")
    .get(SESSION_ID, "agent:main:main") as { conversation_id: number };
  const conversationId = conv.conversation_id;
  let seq = 1;
  let ordinal = 0;
  const markers: string[] = [];

  const insertMessage = (role: string, content: string): number => {
    const row = db
      .prepare("INSERT INTO messages (conversation_id, seq, role, content, token_count) VALUES (?, ?, ?, ?, 1) RETURNING message_id")
      .get(conversationId, seq++, role, content) as { message_id: number };
    ordinal += 1;
    db.prepare("INSERT INTO context_items (conversation_id, ordinal, item_type, message_id) VALUES (?, ?, 'message', ?)")
      .run(conversationId, ordinal, row.message_id);
    return row.message_id;
  };

  const insertToolPair = (i: number): void => {
    const toolCallId = "call-default-cap-" + i;
    const toolUseId = insertMessage("assistant", "");
    db.prepare(
      "INSERT INTO message_parts (part_id, message_id, session_id, part_type, ordinal, tool_call_id, tool_name, tool_input) VALUES (?, ?, ?, 'tool', 0, ?, ?, ?)",
    ).run("p-tu-" + toolUseId, toolUseId, SESSION_ID, toolCallId, "Read", "{}");
    const payload = "tool-output-" + i + ":" + "x".repeat(opts.toolChars);
    const toolResultId = insertMessage("tool", payload);
    db.prepare(
      "INSERT INTO message_parts (part_id, message_id, session_id, part_type, ordinal, tool_call_id, tool_name, tool_output, metadata) VALUES (?, ?, ?, 'tool', 0, ?, ?, ?, ?)",
    ).run(
      "p-tr-" + toolResultId,
      toolResultId,
      SESSION_ID,
      toolCallId,
      "Read",
      payload,
      JSON.stringify({ originalRole: "toolResult", rawType: "tool_result" }),
    );
  };

  // Tool pairs are interleaved, not appended: resolveFreshTailOrdinal protects
  // every raw message after the LATEST user message, so a trailing block of tool
  // results would be protected wholesale and never reach the evictable longtext
  // lane. Ending on a small human turn keeps the protected tail small and leaves
  // the tool results evictable.
  for (let i = 0; i < opts.turns; i++) {
    const marker = "HUMAN-TURN-" + i + "-";
    markers.push(marker);
    insertMessage("user", marker + bigCjk(opts.conversationChars));
    insertMessage("assistant", "assistant-reply-" + i + "-" + bigCjk(opts.conversationChars));
    if (i < opts.toolResults) {
      insertToolPair(i);
    }
  }

  return { conversationId, markers };
}

type EmittedMessage = { role?: unknown; content?: unknown };

function emittedText(messages: ReadonlyArray<EmittedMessage>): string {
  const parts: string[] = [];
  for (const message of messages) {
    const messageContent = message.content;
    if (typeof messageContent === "string") {
      parts.push(messageContent);
    } else if (Array.isArray(messageContent)) {
      for (const block of messageContent) {
        if (
          block &&
          typeof block === "object" &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string"
        ) {
          parts.push((block as { text: string }).text);
        }
      }
    }
  }
  return parts.join("\n");
}

function retainedMarkers(messages: ReadonlyArray<EmittedMessage>, markers: string[]): number {
  const text = emittedText(messages);
  return markers.filter((marker) => text.includes(marker)).length;
}

function newAssembler(db: DatabaseSync): ContextAssembler {
  return new ContextAssembler(new ConversationStore(db), new SummaryStore(db), "UTC");
}

describe("lane-split default conversation cap", () => {
  it("derives a budget-scaled cap, past the old fixed 65536 at large budgets", () => {
    // 118k / 150k are the budgets of the main sessions where the fixed cap hurt.
    expect(deriveConversationLaneTokenCap(118_000)).toBe(Math.floor(118_000 * DEFAULT_CONVERSATION_LANE_BUDGET_RATIO));
    expect(deriveConversationLaneTokenCap(118_000)).toBeGreaterThan(65_536);
    expect(deriveConversationLaneTokenCap(150_000)).toBeGreaterThan(65_536);
    // Monotonic: a bigger budget never yields a smaller cap.
    expect(deriveConversationLaneTokenCap(150_000)).toBeGreaterThan(deriveConversationLaneTokenCap(118_000));
    // Degenerate budgets stay safe.
    expect(deriveConversationLaneTokenCap(Number.NaN)).toBe(Number.MAX_SAFE_INTEGER);
    expect(deriveConversationLaneTokenCap(0)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("keeps human text at a budget larger than the conversation pool (default cap)", async () => {
    const db = createDb();
    const { conversationId, markers } = seedLargeConversation(db, {
      turns: 40,
      conversationChars: 800,
      toolResults: 12,
      toolChars: 30_000,
    });
    const assembler = newAssembler(db);

    // Budget clearly above the conversation pool (~96k tokens) so the derived
    // cap (0.85 x 150k = 127.5k) does not trim the conversation lane. The
    // machine-load lane plus the conversation pool still exceed the budget, so
    // eviction definitely happens.
    const budget = 150_000;
    const input = { conversationId, tokenBudget: budget, freshTailCount: 2 };
    const off = await assembler.assemble(input);
    const on = await assembler.assemble({ ...input, laneSplitEnabled: true });

    expect(off.debug?.selectionMode).toBe("chronological");
    expect(on.debug?.selectionMode).toBe("lane-split");
    expect(on.debug?.laneSplit?.conversationTokenCap).toBe(deriveConversationLaneTokenCap(budget));

    // The whole point: the default cap must not trim the conversation lane.
    expect(on.debug?.laneSplit?.conversationTrimmed).toBe(false);
    expect(retainedMarkers(on.messages, markers)).toBe(markers.length);
    expect(emittedText(on.messages)).toContain(markers[0]);

    // Off (chronological) drops the oldest turns under pressure, so lane split
    // with the default cap retains at least as much human text.
    expect(retainedMarkers(off.messages, markers)).toBeLessThan(markers.length);
    expect(retainedMarkers(on.messages, markers)).toBeGreaterThanOrEqual(
      retainedMarkers(off.messages, markers),
    );
    // Tool output is what gives way: lane split keeps no more tool results than off.
    const countToolResults = (messages: ReadonlyArray<EmittedMessage>) =>
      messages.filter((message) => message.role === "toolResult" || message.role === "tool").length;
    expect(countToolResults(on.messages)).toBeLessThanOrEqual(countToolResults(off.messages));
  });

  it("an explicit cap still overrides the derived default", async () => {
    const db = createDb();
    const { conversationId, markers } = seedLargeConversation(db, {
      turns: 40,
      conversationChars: 800,
      toolResults: 12,
      toolChars: 30_000,
    });
    const assembler = newAssembler(db);

    const on = await assembler.assemble({
      conversationId,
      tokenBudget: 150_000,
      freshTailCount: 2,
      laneSplitEnabled: true,
      laneConversationTokenCap: 5,
    });

    expect(on.debug?.laneSplit?.conversationTokenCap).toBe(5);
    expect(on.debug?.laneSplit?.conversationTrimmed).toBe(true);
    expect(retainedMarkers(on.messages, markers)).toBeLessThan(markers.length);
  });
});

// Lane split (Step 2) — two-budget assembly.
//
// Covers the pure budget policy (selectLanesWithinBudget) and the assembler
// integration behind laneSplitEnabled. The flag defaults to off, so these
// tests also pin the "off == pre-Step-2" contract: when the flag is off the
// new code path is never entered and the emitted messages are unchanged.
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_CONVERSATION_LANE_TOKEN_CAP,
  selectLanesWithinBudget,
} from "../src/lane-split.js";
import { ContextAssembler } from "../src/assembler.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { SummaryStore } from "../src/store/summary-store.js";
import { runLcmMigrations } from "../src/db/migration.js";

describe("selectLanesWithinBudget", () => {
  it("keeps both lanes whole when everything fits", () => {
    const selection = selectLanesWithinBudget([10, 20], [30, 40], 1000, 1000);
    expect(selection.conversationKept).toEqual([true, true]);
    expect(selection.longtextKept).toEqual([true, true]);
    expect(selection.conversationTrimmed).toBe(false);
    expect(selection.longtextTrimmed).toBe(false);
    expect(selection.conversationTokens).toBe(30);
    expect(selection.longtextTokens).toBe(70);
  });

  it("trims longtext oldest-first and never touches the conversation lane", () => {
    // Conversation 30 tokens, longtext 100 tokens, budget 60.
    const selection = selectLanesWithinBudget([10, 20], [50, 30, 20], 60, 65536);
    expect(selection.conversationKept).toEqual([true, true]);
    // Newest L suffix that fits 60 - 30 = 30: 20 + 30 = 50 would overflow, so
    // only the newest 20 survives; the two oldest L items are dropped.
    expect(selection.longtextTrimmed).toBe(true);
    expect(selection.conversationTrimmed).toBe(false);
    expect(selection.longtextKept[2]).toBe(true);
    expect(selection.longtextKept[0]).toBe(false);
  });

  it("applies the absolute conversation cap as the only conversation trimmer", () => {
    // Conversation 100 tokens (40+30+30), cap 70, unlimited budget.
    const selection = selectLanesWithinBudget([40, 30, 30], [10], 1_000_000, 70);
    // Newest C suffix within 70: 30 + 30 = 60; the oldest C item is dropped.
    expect(selection.conversationKept).toEqual([false, true, true]);
    expect(selection.conversationTrimmed).toBe(true);
    expect(selection.conversationTokens).toBe(60);
    expect(selection.longtextKept).toEqual([true]);
  });

  it("starves longtext before it would touch the conversation lane", () => {
    const selection = selectLanesWithinBudget([100], [100, 100], 120, 65536);
    expect(selection.conversationKept).toEqual([true]);
    expect(selection.conversationTrimmed).toBe(false);
    expect(selection.longtextKept).toEqual([false, false]);
    expect(selection.longtextTrimmed).toBe(true);
  });

  it("defaults the conversation cap and tolerates invalid inputs", () => {
    const defaults = selectLanesWithinBudget([], [5], 10);
    expect(defaults.conversationTokenCap).toBe(DEFAULT_CONVERSATION_LANE_TOKEN_CAP);
    const invalid = selectLanesWithinBudget([-5, Number.NaN], [1], Number.NaN, Number.NaN);
    expect(invalid.conversationTokenCap).toBe(DEFAULT_CONVERSATION_LANE_TOKEN_CAP);
    // Negative / NaN token estimates are floored to 0, so zero-cost items stay.
    expect(invalid.conversationKept).toEqual([true, true]);
  });
});

type SeededConversation = {
  conversationId: number;
  userTexts: string[];
};

function createAssemblerDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  runLcmMigrations(db, { fts5Available: false });
  return db;
}

function seedLaneConversation(
  db: DatabaseSync,
  turns: number,
  payloadChars: number,
): SeededConversation {
  const conv = db
    .prepare(
      "INSERT INTO conversations (session_id, session_key, active) VALUES (?, ?, 1) RETURNING conversation_id",
    )
    .get("lane-split-session", "agent:main:main") as { conversation_id: number };
  const conversationId = conv.conversation_id;
  const userTexts: string[] = [];
  let seq = 1;
  let ordinal = 0;

  const insertMessage = (role: string, messageContent: string): number => {
    const row = db
      .prepare(
        "INSERT INTO messages (conversation_id, seq, role, content, token_count) VALUES (?, ?, ?, ?, 1) RETURNING message_id",
      )
      .get(conversationId, seq++, role, messageContent) as { message_id: number };
    ordinal += 1;
    db.prepare(
      "INSERT INTO context_items (conversation_id, ordinal, item_type, message_id) VALUES (?, ?, 'message', ?)",
    ).run(conversationId, ordinal, row.message_id);
    return row.message_id;
  };

  for (let i = 0; i < turns; i++) {
    const userText = "user-turn-" + i;
    userTexts.push(userText);
    insertMessage("user", userText);
    insertMessage("assistant", "assistant-reply-" + i);

    const toolCallId = "call-lane-" + i;
    const toolUseMessageId = insertMessage("assistant", "");
    db.prepare(
      "INSERT INTO message_parts (part_id, message_id, session_id, part_type, ordinal, tool_call_id, tool_name, tool_input) VALUES (?, ?, ?, 'tool', 0, ?, ?, ?)",
    ).run(
      "p-" + toolUseMessageId + "-tu",
      toolUseMessageId,
      "lane-split-session",
      toolCallId,
      "Read",
      "{}",
    );

    const payload = "tool-output-" + i + ":" + "x".repeat(payloadChars);
    const toolResultMessageId = insertMessage("tool", payload);
    db.prepare(
      "INSERT INTO message_parts (part_id, message_id, session_id, part_type, ordinal, tool_call_id, tool_name, tool_output, metadata) VALUES (?, ?, ?, 'tool', 0, ?, ?, ?, ?)",
    ).run(
      "p-" + toolResultMessageId + "-tr",
      toolResultMessageId,
      "lane-split-session",
      toolCallId,
      "Read",
      payload,
      JSON.stringify({ originalRole: "toolResult", rawType: "tool_result" }),
    );
  }

  return { conversationId, userTexts };
}

type EmittedMessage = {
  role?: unknown;
  content?: unknown;
  reasoning_content?: unknown;
};

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
    if (typeof message.reasoning_content === "string") {
      parts.push(message.reasoning_content);
    }
  }
  return parts.join("\n");
}

function countToolResults(messages: ReadonlyArray<EmittedMessage>): number {
  return messages.filter(
    (message) => message.role === "toolResult" || message.role === "tool",
  ).length;
}

/** Number of emitted user turns that match the seeded "user-turn-N" shape. */
function countEmittedUserTurns(messages: ReadonlyArray<EmittedMessage>): number {
  return messages.filter(
    (message) =>
      message.role === "user" &&
      typeof message.content === "string" &&
      message.content.startsWith("user-turn-"),
  ).length;
}

function newAssembler(db: DatabaseSync): ContextAssembler {
  return new ContextAssembler(new ConversationStore(db), new SummaryStore(db), "UTC");
}

describe("lane-split assembly behind the flag", () => {
  it("longtext absorbs all eviction while every conversation turn survives", async () => {
    const db = createAssemblerDb();
    const { conversationId, userTexts } = seedLaneConversation(db, 12, 4000);
    const assembler = newAssembler(db);

    const input = { conversationId, tokenBudget: 6000, freshTailCount: 2 };
    const off = await assembler.assemble(input);
    const on = await assembler.assemble({
      ...input,
      laneSplitEnabled: true,
      laneConversationTokenCap: DEFAULT_CONVERSATION_LANE_TOKEN_CAP,
    });

    // Off (pre-Step-2) evicts chronologically and loses the oldest turns.
    const offText = emittedText(off.messages);
    const onText = emittedText(on.messages);
    expect(offText).not.toContain(userTexts[0]);
    expect(off.debug?.selectionMode).toBe("chronological");
    expect(off.debug).not.toHaveProperty("laneSplit");

    // On keeps the whole conversation lane: no conversation turn is dropped.
    for (const text of userTexts) {
      expect(onText).toContain(text);
    }
    expect(on.debug?.selectionMode).toBe("lane-split");
    expect(on.debug?.laneSplit?.conversationTrimmed).toBe(false);
    expect(on.debug?.laneSplit?.longtextTrimmed).toBe(true);

    // The conversation lane is retained in full; off-mode lost turns instead.
    expect(countEmittedUserTurns(on.messages)).toBe(userTexts.length);
    expect(countEmittedUserTurns(off.messages)).toBeLessThan(userTexts.length);
    // And on-mode never keeps more tool results than the un-laned path.
    expect(countToolResults(on.messages)).toBeLessThanOrEqual(countToolResults(off.messages));
  });

  it("the absolute conversation cap is the only thing that trims conversation", async () => {
    const db = createAssemblerDb();
    const { conversationId, userTexts } = seedLaneConversation(db, 12, 2000);
    const assembler = newAssembler(db);

    const on = await assembler.assemble({
      conversationId,
      tokenBudget: 1_000_000,
      freshTailCount: 2,
      laneSplitEnabled: true,
      laneConversationTokenCap: 5,
    });

    expect(on.debug?.laneSplit?.conversationTrimmed).toBe(true);
    expect(on.debug?.laneSplit?.conversationTokenCap).toBe(5);
    // With a 5-token cap the oldest conversation turns cannot fit.
    expect(emittedText(on.messages)).not.toContain(userTexts[0]);
  });

  it("flag off is byte-for-byte identical to flag on when nothing needs trimming", async () => {
    const db = createAssemblerDb();
    const { conversationId } = seedLaneConversation(db, 2, 40);
    const assembler = newAssembler(db);

    const input = { conversationId, tokenBudget: 100_000, freshTailCount: 4 };
    const off = await assembler.assemble(input);
    const on = await assembler.assemble({ ...input, laneSplitEnabled: true });

    expect(JSON.stringify(on.messages)).toBe(JSON.stringify(off.messages));
    expect(on.estimatedTokens).toBe(off.estimatedTokens);
    expect(on.stats).toEqual(off.stats);
    // Only the flag-gated diagnostics differ.
    expect(off.debug).not.toHaveProperty("laneSplit");
    expect(on.debug).toHaveProperty("laneSplit");
  });

  it("explicit laneSplitEnabled false matches the omitted default", async () => {
    const db = createAssemblerDb();
    const { conversationId } = seedLaneConversation(db, 8, 3000);
    const assembler = newAssembler(db);

    const input = { conversationId, tokenBudget: 3000, freshTailCount: 2 };
    const omitted = await assembler.assemble(input);
    const explicitOff = await assembler.assemble({ ...input, laneSplitEnabled: false });

    expect(JSON.stringify(explicitOff.messages)).toBe(JSON.stringify(omitted.messages));
    expect(explicitOff.debug?.selectionMode).toBe(omitted.debug?.selectionMode);
    expect(omitted.debug).not.toHaveProperty("laneSplit");
    expect(explicitOff.debug).not.toHaveProperty("laneSplit");
  });
});

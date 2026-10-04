// Lane split (Step 3) — reasoning blocks yield first inside the conversation lane.
//
//   inline (default) — reasoning counts as ordinary conversation tokens, so the
//     emitted messages are byte-for-byte identical to Step 2.
//   lowest — under conversation-lane cap pressure reasoning blocks are dropped
//     before any whole message, so text retention strictly improves.
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_CONVERSATION_LANE_TOKEN_CAP,
  selectLanesWithinBudget,
  selectLanesWithinBudgetWithReasoning,
} from "../src/lane-split.js";
import { ContextAssembler } from "../src/assembler.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { SummaryStore } from "../src/store/summary-store.js";
import { runLcmMigrations } from "../src/db/migration.js";

describe("selectLanesWithinBudgetWithReasoning", () => {
  it("inline mode is exactly Step 2", () => {
    const inline = selectLanesWithinBudgetWithReasoning(
      [
        { reasoningTokens: 40, textTokens: 10 },
        { reasoningTokens: 30, textTokens: 20 },
      ],
      [50],
      60,
      65536,
      "inline",
    );
    const step2 = selectLanesWithinBudget([50, 50], [50], 60, 65536);
    expect(inline.conversationKept).toEqual(step2.conversationKept);
    expect(inline.longtextKept).toEqual(step2.longtextKept);
    expect(inline.conversationTokens).toBe(step2.conversationTokens);
    expect(inline.longtextTokens).toBe(step2.longtextTokens);
    expect(inline.reasoningDropped).toEqual([false, false]);
    expect(inline.reasoningTrimmed).toBe(false);
  });

  it("does not shed reasoning when the lane fits", () => {
    const selection = selectLanesWithinBudgetWithReasoning(
      [{ reasoningTokens: 100, textTokens: 20 }],
      [],
      1000,
      65536,
      "lowest",
    );
    expect(selection.reasoningDropped).toEqual([false]);
    expect(selection.conversationKept).toEqual([true]);
    expect(selection.reasoningTokens).toBe(100);
    expect(selection.conversationTextTokens).toBe(20);
    expect(selection.reasoningTrimmed).toBe(false);
  });

  it("sheds oldest reasoning first and keeps every item's text", () => {
    // 4 items: reasoning 30 + text 10 = 40 each → 160 total, cap 80.
    const selection = selectLanesWithinBudgetWithReasoning(
      [
        { reasoningTokens: 30, textTokens: 10 },
        { reasoningTokens: 30, textTokens: 10 },
        { reasoningTokens: 30, textTokens: 10 },
        { reasoningTokens: 30, textTokens: 10 },
      ],
      [],
      80,
      65536,
      "lowest",
    );
    // overflow 80 → the three oldest items' reasoning (90) is shed.
    expect(selection.reasoningDropped).toEqual([true, true, true, false]);
    expect(selection.conversationKept).toEqual([true, true, true, true]);
    expect(selection.conversationTrimmed).toBe(false);
    expect(selection.conversationTextTokens).toBe(40);
    expect(selection.reasoningTokens).toBe(30);
    expect(selection.conversationTokens).toBe(70);
    expect(selection.reasoningTrimmed).toBe(true);
  });

  it("drops whole messages only after all reasoning is gone", () => {
    // 3 items: reasoning 10 + text 30 = 40 each → 120 total, cap 50.
    // Step 3 semantics are requested explicitly ("always"): the Step 4 default
    // is "purpose-bound", which sheds nothing here because the lane's
    // non-reasoning footprint (90) already exceeds the cap (50).
    const selection = selectLanesWithinBudgetWithReasoning(
      [
        { reasoningTokens: 10, textTokens: 30 },
        { reasoningTokens: 10, textTokens: 30 },
        { reasoningTokens: 10, textTokens: 30 },
      ],
      [],
      50,
      65536,
      "lowest",
      "always",
    );
    // All reasoning shed (30) still leaves 90 text > 50; the newest single
    // 30-token text item is all that fits.
    expect(selection.reasoningTrimmed).toBe(true);
    expect(selection.conversationKept).toEqual([false, false, true]);
    expect(selection.conversationTextTokens).toBe(30);
    expect(selection.conversationTokens).toBe(30);
  });

  it("never exceeds the cap, even with reasoning shedding", () => {
    const selection = selectLanesWithinBudgetWithReasoning(
      Array.from({ length: 6 }, () => ({ reasoningTokens: 100, textTokens: 40 })),
      [200],
      150,
      65536,
      "lowest",
    );
    expect(selection.conversationTokens).toBeLessThanOrEqual(150);
    expect(selection.conversationTokens + selection.longtextTokens).toBeLessThanOrEqual(150);
  });
});

type Seeded = { conversationId: number; assistantTexts: string[] };

function createAssemblerDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  runLcmMigrations(db, { fts5Available: false });
  return db;
}

/** Seed turns of (user, assistant[reasoning+text], assistant tool_use, tool result). */
function seedReasoningConversation(
  db: DatabaseSync,
  turns: number,
  reasoningChars: number,
  toolChars: number,
): Seeded {
  const conv = db
    .prepare(
      "INSERT INTO conversations (session_id, session_key, active) VALUES (?, ?, 1) RETURNING conversation_id",
    )
    .get("lane-split-step3", "agent:main:main") as { conversation_id: number };
  const conversationId = conv.conversation_id;
  const assistantTexts: string[] = [];
  let seq = 1;
  let ordinal = 0;

  const insertMessage = (role: string, content: string): number => {
    const row = db
      .prepare(
        "INSERT INTO messages (conversation_id, seq, role, content, token_count) VALUES (?, ?, ?, ?, 1) RETURNING message_id",
      )
      .get(conversationId, seq++, role, content) as { message_id: number };
    ordinal += 1;
    db.prepare(
      "INSERT INTO context_items (conversation_id, ordinal, item_type, message_id) VALUES (?, ?, 'message', ?)",
    ).run(conversationId, ordinal, row.message_id);
    return row.message_id;
  };

  for (let i = 0; i < turns; i++) {
    insertMessage("user", "user-turn-" + i);
    const assistantText = "assistant-text-" + i;
    assistantTexts.push(assistantText);
    const assistantId = insertMessage("assistant", "");
    db.prepare(
      "INSERT INTO message_parts (part_id, message_id, session_id, part_type, ordinal, text_content) VALUES (?, ?, ?, 'reasoning', 0, ?)",
    ).run("p-" + assistantId + "-r", assistantId, "lane-split-step3", "R".repeat(reasoningChars));
    db.prepare(
      "INSERT INTO message_parts (part_id, message_id, session_id, part_type, ordinal, text_content) VALUES (?, ?, ?, 'text', 1, ?)",
    ).run("p-" + assistantId + "-t", assistantId, "lane-split-step3", assistantText);

    const toolCallId = "call-step3-" + i;
    const toolUseMessageId = insertMessage("assistant", "");
    db.prepare(
      "INSERT INTO message_parts (part_id, message_id, session_id, part_type, ordinal, tool_call_id, tool_name, tool_input) VALUES (?, ?, ?, 'tool', 0, ?, ?, ?)",
    ).run(
      "p-" + toolUseMessageId + "-tu",
      toolUseMessageId,
      "lane-split-step3",
      toolCallId,
      "Read",
      "{}",
    );

    const payload = "tool-output-" + i + ":" + "x".repeat(toolChars);
    const toolResultMessageId = insertMessage("tool", payload);
    db.prepare(
      "INSERT INTO message_parts (part_id, message_id, session_id, part_type, ordinal, tool_call_id, tool_name, tool_output, metadata) VALUES (?, ?, ?, 'tool', 0, ?, ?, ?, ?)",
    ).run(
      "p-" + toolResultMessageId + "-tr",
      toolResultMessageId,
      "lane-split-step3",
      toolCallId,
      "Read",
      payload,
      JSON.stringify({ originalRole: "toolResult", rawType: "tool_result" }),
    );
  }

  return { conversationId, assistantTexts };
}

type EmittedMessage = { role?: unknown; content?: unknown };

const REASONING_TYPES = new Set(["reasoning", "thinking", "redacted_thinking"]);

function isReasoningBlock(block: unknown): boolean {
  if (!block || typeof block !== "object") return false;
  const type = (block as { type?: unknown }).type;
  return typeof type === "string" && REASONING_TYPES.has(type);
}

/** Emitted "human text" characters: string content plus non-reasoning text blocks. */
function emittedTextChars(messages: ReadonlyArray<EmittedMessage>): number {
  let chars = 0;
  for (const message of messages) {
    const content = message.content;
    if (typeof content === "string") {
      chars += content.length;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        const record = block as { type?: unknown; text?: unknown };
        if (record?.type === "text" && typeof record.text === "string") {
          chars += record.text.length;
        }
      }
    }
  }
  return chars;
}

function emittedReasoningChars(messages: ReadonlyArray<EmittedMessage>): number {
  let chars = 0;
  for (const message of messages) {
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (isReasoningBlock(block)) chars += JSON.stringify(block).length;
    }
  }
  return chars;
}

/** Assistant text-bearing messages whose emitted content carries no reasoning. */
function textWithoutReasoning(messages: ReadonlyArray<EmittedMessage>): number {
  let count = 0;
  for (const message of messages) {
    const content = message.content;
    if (!Array.isArray(content)) continue;
    const hasText = content.some(
      (block) =>
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string" &&
        ((block as { text: string }).text.startsWith("assistant-text-")),
    );
    const hasReasoning = content.some(isReasoningBlock);
    if (hasText && !hasReasoning) count += 1;
  }
  return count;
}

function newAssembler(db: DatabaseSync): ContextAssembler {
  return new ContextAssembler(new ConversationStore(db), new SummaryStore(db), "UTC");
}

describe("lane-split step 3 behind the flag", () => {
  it("omitted/inline reasoning mode is byte-for-byte identical to Step 2", async () => {
    const db = createAssemblerDb();
    const { conversationId } = seedReasoningConversation(db, 10, 2000, 6000);
    const assembler = newAssembler(db);

    const input = { conversationId, tokenBudget: 4000, freshTailCount: 2 };
    const step2 = await assembler.assemble({ ...input, laneSplitEnabled: true });
    const omitted = await assembler.assemble({
      ...input,
      laneSplitEnabled: true,
      laneConversationTokenCap: DEFAULT_CONVERSATION_LANE_TOKEN_CAP,
    });
    const explicitInline = await assembler.assemble({
      ...input,
      laneSplitEnabled: true,
      laneReasoningMode: "inline",
    });

    expect(JSON.stringify(omitted.messages)).toBe(JSON.stringify(step2.messages));
    expect(JSON.stringify(explicitInline.messages)).toBe(JSON.stringify(step2.messages));
    expect(omitted.estimatedTokens).toBe(step2.estimatedTokens);
    expect(explicitInline.estimatedTokens).toBe(step2.estimatedTokens);
    expect(step2.debug?.laneSplit).not.toHaveProperty("reasoningMode");
    expect(explicitInline.debug?.laneSplit).not.toHaveProperty("reasoningMode");
  });

  it("flag off ignores laneReasoningMode entirely", async () => {
    const db = createAssemblerDb();
    const { conversationId } = seedReasoningConversation(db, 8, 1500, 3000);
    const assembler = newAssembler(db);

    const input = { conversationId, tokenBudget: 3000, freshTailCount: 2 };
    const off = await assembler.assemble(input);
    const offWithMode = await assembler.assemble({
      ...input,
      laneSplitEnabled: false,
      laneReasoningMode: "lowest",
    });

    expect(JSON.stringify(offWithMode.messages)).toBe(JSON.stringify(off.messages));
    expect(offWithMode.estimatedTokens).toBe(off.estimatedTokens);
    expect(offWithMode.debug).not.toHaveProperty("laneSplit");
  });

  it("lowest keeps every text message and drains reasoning under pressure", async () => {
    const db = createAssemblerDb();
    const { conversationId, assistantTexts } = seedReasoningConversation(db, 10, 2000, 6000);
    const assembler = newAssembler(db);

    const input = { conversationId, tokenBudget: 4000, freshTailCount: 2 };
    const off = await assembler.assemble(input);
    const inline = await assembler.assemble({ ...input, laneSplitEnabled: true });
    const lowest = await assembler.assemble({
      ...input,
      laneSplitEnabled: true,
      laneReasoningMode: "lowest",
    });

    // The win: strictly more human text survives at the same budget.
    expect(emittedTextChars(lowest.messages as unknown as EmittedMessage[])).toBeGreaterThan(
      emittedTextChars(inline.messages as unknown as EmittedMessage[]),
    );
    // Reasoning is the first thing sacrificed: the kept reasoning never grows,
    // and at least some of it is actually shed (see reasoningTrimmed below).
    // It need not shrink below inline's: the newest items keep their reasoning
    // in both modes, while lowest additionally keeps older text-only shells.
    expect(emittedReasoningChars(lowest.messages as unknown as EmittedMessage[])).toBeLessThanOrEqual(
      emittedReasoningChars(inline.messages as unknown as EmittedMessage[]),
    );
    // A message may lose its reasoning while keeping its text.
    expect(textWithoutReasoning(inline.messages as unknown as EmittedMessage[])).toBe(0);
    expect(textWithoutReasoning(lowest.messages as unknown as EmittedMessage[])).toBeGreaterThan(0);
    for (const text of assistantTexts) {
      expect(
        (lowest.messages as unknown as EmittedMessage[]).some((message) =>
          Array.isArray(message.content) &&
          message.content.some(
            (block) =>
              (block as { type?: unknown }).type === "text" &&
              (block as { text?: unknown }).text === text,
          ),
        ),
      ).toBe(true);
    }
    // The budget is still a hard ceiling (`cap <= remainingBudget` is
    // unchanged): lowest spends the slack inline leaves to keep more text, but
    // never overshoots the budget itself. This is the ceiling that matters.
    expect(lowest.estimatedTokens).toBeLessThanOrEqual(input.tokenBudget);
    expect(inline.estimatedTokens).toBeLessThanOrEqual(input.tokenBudget);
    expect(off.estimatedTokens).toBeLessThanOrEqual(input.tokenBudget);
    expect(lowest.debug?.laneSplit?.reasoningMode).toBe("lowest");
    expect(lowest.debug?.laneSplit?.reasoningTrimmed).toBe(true);
  });

  it("lowest is identical to inline when the conversation lane fits", async () => {
    const db = createAssemblerDb();
    const { conversationId } = seedReasoningConversation(db, 6, 800, 1000);
    const assembler = newAssembler(db);

    const input = { conversationId, tokenBudget: 100_000, freshTailCount: 4 };
    const inline = await assembler.assemble({ ...input, laneSplitEnabled: true });
    const lowest = await assembler.assemble({
      ...input,
      laneSplitEnabled: true,
      laneReasoningMode: "lowest",
    });

    expect(JSON.stringify(lowest.messages)).toBe(JSON.stringify(inline.messages));
    expect(lowest.debug?.laneSplit?.reasoningTrimmed).toBe(false);
    expect(lowest.debug?.laneSplit?.reasoningTokens).toBeGreaterThan(0);
  });
});

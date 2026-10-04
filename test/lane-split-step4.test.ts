// Lane split (Step 4) — purpose-bound reasoning shedding.
//
//   "always" (default) — Step 3 behavior: shed the minimum necessary reasoning
//     oldest-first to meet the conversation-lane cap, even when the lane's
//     non-reasoning footprint already exceeds the cap (so the shed cannot make
//     the lane fit).
//   "purpose-bound" — shed reasoning only when the non-reasoning footprint
//     already fits the cap (the shed can then actually make the lane fit).
//     Otherwise shed nothing, degrading to the inline/Step 2 result.
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { selectLanesWithinBudgetWithReasoning } from "../src/lane-split.js";
import { ContextAssembler } from "../src/assembler.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { SummaryStore } from "../src/store/summary-store.js";
import { runLcmMigrations } from "../src/db/migration.js";

describe("selectLanesWithinBudgetWithReasoning — Step 4 shed policy", () => {
  // 3 items: reasoning 100 + text 20 = 120 each → 360 total, cap 100.
  // nonReasoningTotal = 60 <= 100 → shedding CAN fit the lane.
  const reasonFitsItems = [
    { reasoningTokens: 100, textTokens: 20 },
    { reasoningTokens: 100, textTokens: 20 },
    { reasoningTokens: 100, textTokens: 20 },
  ];

  it("defaults to \"always\" (the policy argument is optional)", () => {
    const withDefault = selectLanesWithinBudgetWithReasoning(
      reasonFitsItems, [], 1000, 100, "lowest",
    );
    const explicitAlways = selectLanesWithinBudgetWithReasoning(
      reasonFitsItems, [], 1000, 100, "lowest", "always",
    );
    expect(withDefault).toEqual(explicitAlways);
    expect(withDefault.reasoningShedPolicy).toBe("always");
  });

  it("purpose-bound sheds like always when the non-reasoning footprint fits the cap", () => {
    const always = selectLanesWithinBudgetWithReasoning(
      reasonFitsItems, [], 1000, 100, "lowest", "always",
    );
    const purposeBound = selectLanesWithinBudgetWithReasoning(
      reasonFitsItems, [], 1000, 100, "lowest", "purpose-bound",
    );
    expect(purposeBound.conversationKept).toEqual(always.conversationKept);
    expect(purposeBound.longtextKept).toEqual(always.longtextKept);
    expect(purposeBound.conversationTokens).toBe(always.conversationTokens);
    expect(purposeBound.reasoningDropped).toEqual(always.reasoningDropped);
    expect(purposeBound.reasoningTrimmed).toBe(true);
    expect(purposeBound.nonReasoningTotal).toBe(60);
    expect(purposeBound.reasoningShedPolicy).toBe("purpose-bound");
  });

  it("purpose-bound sheds NOTHING when even all reasoning cannot fit the cap", () => {
    // 3 items: [reasoning 200, text 40], [5, 40], [5, 40] → total 330, cap 100.
    // nonReasoningTotal = 120 > 100, so shed-all still overshoots by 20.
    const items = [
      { reasoningTokens: 200, textTokens: 40 },
      { reasoningTokens: 5, textTokens: 40 },
      { reasoningTokens: 5, textTokens: 40 },
    ];
    const always = selectLanesWithinBudgetWithReasoning(
      items, [], 1000, 100, "lowest", "always",
    );
    const purposeBound = selectLanesWithinBudgetWithReasoning(
      items, [], 1000, 100, "lowest", "purpose-bound",
    );
    const inline = selectLanesWithinBudgetWithReasoning(
      items, [], 1000, 100, "inline", "purpose-bound",
    );
    // always spends all reasoning (200+5+5) and keeps 2 whole text items.
    expect(always.reasoningTrimmed).toBe(true);
    expect(always.conversationTokens).toBe(80);
    // purpose-bound refuses the pointless shed: nothing dropped, identical to inline.
    expect(purposeBound.reasoningDropped).toEqual([false, false, false]);
    expect(purposeBound.reasoningTrimmed).toBe(false);
    expect(purposeBound.reasoningTokens).toBe(0 + 5 + 5);
    expect(purposeBound.conversationTextTokens).toBe(80);
    expect(purposeBound.conversationTokens).toBe(90);
    expect(purposeBound.conversationKept).toEqual(inline.conversationKept);
    expect(purposeBound.conversationTokens).toBe(inline.conversationTokens);
    expect(purposeBound.reasoningDropped).toEqual(inline.reasoningDropped);
    expect(JSON.stringify(purposeBound)).toBe(JSON.stringify(inline));
  });

  it("purpose-bound still respects the cap (never overshoots)", () => {
    const items = [
      { reasoningTokens: 200, textTokens: 40 },
      { reasoningTokens: 5, textTokens: 40 },
      { reasoningTokens: 5, textTokens: 40 },
    ];
    const selection = selectLanesWithinBudgetWithReasoning(
      items, [500], 1000, 100, "lowest", "purpose-bound",
    );
    // The cap bounds the CONVERSATION lane; the whole selection is bounded by
    // the remaining budget.
    expect(selection.conversationTokens).toBeLessThanOrEqual(100);
    expect(selection.conversationTokens + selection.longtextTokens).toBeLessThanOrEqual(1000);
  });

  it("purpose-bound reproduces always when policy is irrelevant (inline mode)", () => {
    const inline = selectLanesWithinBudgetWithReasoning(
      reasonFitsItems, [], 1000, 100, "inline",
    );
    const pb = selectLanesWithinBudgetWithReasoning(
      reasonFitsItems, [], 1000, 100, "inline", "purpose-bound",
    );
    // Inline mode never sheds, so the only difference is the reported policy.
    const withoutPolicy = (
      selection: ReturnType<typeof selectLanesWithinBudgetWithReasoning>,
    ) => JSON.stringify({ ...selection, reasoningShedPolicy: undefined });
    expect(withoutPolicy(pb)).toBe(withoutPolicy(inline));
  });
});

type Seeded = { conversationId: number };

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
  textChars: number,
  toolChars: number,
): Seeded {
  const conv = db
    .prepare(
      "INSERT INTO conversations (session_id, session_key, active) VALUES (?, ?, 1) RETURNING conversation_id",
    )
    .get("lane-split-step4", "agent:main:main") as { conversation_id: number };
  const conversationId = conv.conversation_id;
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
    insertMessage("user", "user-turn-" + i + ":" + "u".repeat(textChars));
    const assistantId = insertMessage("assistant", "");
    db.prepare(
      "INSERT INTO message_parts (part_id, message_id, session_id, part_type, ordinal, text_content) VALUES (?, ?, ?, 'reasoning', 0, ?)",
    ).run("p-" + assistantId + "-r", assistantId, "lane-split-step4", "R".repeat(reasoningChars));
    db.prepare(
      "INSERT INTO message_parts (part_id, message_id, session_id, part_type, ordinal, text_content) VALUES (?, ?, ?, 'text', 1, ?)",
    ).run("p-" + assistantId + "-t", assistantId, "lane-split-step4", "T".repeat(textChars));

    const toolCallId = "call-step4-" + i;
    const toolUseMessageId = insertMessage("assistant", "");
    db.prepare(
      "INSERT INTO message_parts (part_id, message_id, session_id, part_type, ordinal, tool_call_id, tool_name, tool_input) VALUES (?, ?, ?, 'tool', 0, ?, ?, ?)",
    ).run("p-" + toolUseMessageId + "-tu", toolUseMessageId, "lane-split-step4", toolCallId, "Read", "{}");

    const payload = "tool-output-" + i + ":" + "x".repeat(toolChars);
    const toolResultMessageId = insertMessage("tool", payload);
    db.prepare(
      "INSERT INTO message_parts (part_id, message_id, session_id, part_type, ordinal, tool_call_id, tool_name, tool_output, metadata) VALUES (?, ?, ?, 'tool', 0, ?, ?, ?, ?)",
    ).run(
      "p-" + toolResultMessageId + "-tr",
      toolResultMessageId,
      "lane-split-step4",
      toolCallId,
      "Read",
      payload,
      JSON.stringify({ originalRole: "toolResult", rawType: "tool_result" }),
    );
  }

  return { conversationId };
}

function newAssembler(db: DatabaseSync): ContextAssembler {
  return new ContextAssembler(new ConversationStore(db), new SummaryStore(db), "UTC");
}

describe("lane-split step 4 behind the flag", () => {
  it("purpose-bound is byte-for-byte the inline result when the lane cannot be fit", async () => {
    const db = createAssemblerDb();
    const { conversationId } = seedReasoningConversation(db, 12, 1200, 400, 4000);
    const assembler = newAssembler(db);

    const input = { conversationId, tokenBudget: 4000, freshTailCount: 2 };
    const inline = await assembler.assemble({ ...input, laneSplitEnabled: true });
    const purposeBound = await assembler.assemble({
      ...input,
      laneSplitEnabled: true,
      laneReasoningMode: "lowest",
      laneReasoningShedPolicy: "purpose-bound",
    });

    expect(JSON.stringify(purposeBound.messages)).toBe(JSON.stringify(inline.messages));
    expect(purposeBound.estimatedTokens).toBe(inline.estimatedTokens);
    expect(purposeBound.debug?.laneSplit?.reasoningShedPolicy).toBe("purpose-bound");
    expect(purposeBound.debug?.laneSplit?.reasoningTrimmed).toBe(false);
  });

  it("default and explicit \"always\" reproduce Step 3 (identical messages)", async () => {
    const db = createAssemblerDb();
    const { conversationId } = seedReasoningConversation(db, 12, 1200, 400, 4000);
    const assembler = newAssembler(db);

    const input = { conversationId, tokenBudget: 4000, freshTailCount: 2 };
    const omitted = await assembler.assemble({
      ...input,
      laneSplitEnabled: true,
      laneReasoningMode: "lowest",
    });
    const explicit = await assembler.assemble({
      ...input,
      laneSplitEnabled: true,
      laneReasoningMode: "lowest",
      laneReasoningShedPolicy: "always",
    });

    expect(JSON.stringify(omitted.messages)).toBe(JSON.stringify(explicit.messages));
    expect(omitted.debug?.laneSplit?.reasoningShedPolicy).toBe("always");
    expect(explicit.debug?.laneSplit?.reasoningShedPolicy).toBe("always");
  });

  it("flag off ignores laneReasoningShedPolicy entirely", async () => {
    const db = createAssemblerDb();
    const { conversationId } = seedReasoningConversation(db, 8, 1000, 300, 3000);
    const assembler = newAssembler(db);

    const input = { conversationId, tokenBudget: 3000, freshTailCount: 2 };
    const off = await assembler.assemble(input);
    const offWithPolicy = await assembler.assemble({
      ...input,
      laneSplitEnabled: false,
      laneReasoningMode: "lowest",
      laneReasoningShedPolicy: "purpose-bound",
    });

    expect(JSON.stringify(offWithPolicy.messages)).toBe(JSON.stringify(off.messages));
    expect(offWithPolicy.estimatedTokens).toBe(off.estimatedTokens);
    expect(offWithPolicy.debug).not.toHaveProperty("laneSplit");
  });
});

/**
 * Lane split (Step 1) — offline assembly-composition harness.
 *
 * Answers one falsifiable question: in the message list the assembler
 * actually emits, which part types survive, and does reasoning survive?
 *
 * Reads a *copy* of a production DB snapshot (never the live DB), rebuilds
 * the assembled prompt through the real ContextAssembler path, and reports
 * per-bucket character composition to a report file.
 *
 * Usage:
 *   LANE_SPLIT_DB=/tmp/lcm_snap/lcm.db npx vitest run test/lane-split-harness.test.ts
 *
 * When LANE_SPLIT_DB does not exist the suite self-skips, so it never breaks
 * the normal test run.
 */
import { describe, it, expect } from "vitest";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ConversationStore } from "../src/store/conversation-store.js";
import { SummaryStore } from "../src/store/summary-store.js";
import { ContextAssembler } from "../src/assembler.js";
import {
  closeLcmConnection,
  createLcmDatabaseConnection,
} from "../src/db/connection.js";

// No default path: the default test run must stay hermetic. Point the harness
// at a snapshot copy explicitly (never the live DB) to activate it.
const SNAPSHOT = process.env.LANE_SPLIT_DB ?? "";
const CONVERSATION_ID = Number(process.env.LANE_SPLIT_CONV ?? "805");
const REPORT_PATH = process.env.LANE_SPLIT_OUT ?? join(tmpdir(), "lane-split-harness-output.txt");
const BUDGETS = (process.env.LANE_SPLIT_BUDGETS ?? "118000,9007199254740991")
  .split(",")
  .map((value) => Number(value.trim()));
const CONVERSATION_CAP_RAW = Number(process.env.LANE_SPLIT_CONV_CAP ?? "");
const CONVERSATION_CAP =
  Number.isFinite(CONVERSATION_CAP_RAW) && CONVERSATION_CAP_RAW > 0
    ? CONVERSATION_CAP_RAW
    : undefined;
// Fresh tail is protected from eviction; 64 protects almost any small session,
// so expose it to force real eviction pressure in the comparison run.
const FRESH_TAIL_RAW = Number(process.env.LANE_SPLIT_FRESH_TAIL ?? "");
const FRESH_TAIL_COUNT =
  Number.isFinite(FRESH_TAIL_RAW) && FRESH_TAIL_RAW > 0 ? FRESH_TAIL_RAW : 64;
// Step 3 — when set to "lowest", additionally assemble each budget with
// reasoning shedding enabled and report flag-off / flag-on (lowest) side by
// side. Reporting only: this never changes the existing assertions.
const REASONING_MODE = process.env.LANE_SPLIT_REASONING_MODE === "lowest" ? "lowest" : undefined;

const REASONING_TYPES = new Set(["reasoning", "thinking", "redacted_thinking"]);
const TOOL_TYPES = new Set([
  "toolCall",
  "toolUse",
  "tool_use",
  "tool-use",
  "functionCall",
  "function_call",
  "toolResult",
  "tool_result",
  "function_call_output",
  "functionCallOutput",
]);

type Bucket = "reasoning" | "tool" | "text" | "other";

/** Tool *results* arrive as role=tool carrying type=text blocks, so bucketing
 *  by block type alone mislabels them as ordinary text. Bucket by role first. */
function isToolResultRole(role: unknown): boolean {
  return role === "tool" || role === "toolResult" || role === "tool_result";
}

function bucketOfType(type: unknown): Bucket {
  if (typeof type !== "string") return "other";
  if (REASONING_TYPES.has(type)) return "reasoning";
  if (TOOL_TYPES.has(type)) return "tool";
  if (type === "text") return "text";
  return "other";
}

function serializedLength(value: unknown): number {
  try {
    const text = JSON.stringify(value);
    return typeof text === "string" ? text.length : 0;
  } catch {
    return 0;
  }
}

type Composition = {
  budget: number;
  messageCount: number;
  blockCount: number;
  buckets: Record<Bucket, { blocks: number; chars: number }>;
  reasoningContentMessages: number;
  reasoningContentChars: number;
  stringMessages: number;
  emptyArrayMessages: number;
  examples: string[];
};

function analyze(budget: number, messages: Array<Record<string, unknown>>): Composition {
  const buckets: Composition["buckets"] = {
    reasoning: { blocks: 0, chars: 0 },
    tool: { blocks: 0, chars: 0 },
    text: { blocks: 0, chars: 0 },
    other: { blocks: 0, chars: 0 },
  };
  const composition: Composition = {
    budget,
    messageCount: messages.length,
    blockCount: 0,
    buckets,
    reasoningContentMessages: 0,
    reasoningContentChars: 0,
    stringMessages: 0,
    emptyArrayMessages: 0,
    examples: [],
  };

  for (const message of messages) {
    const content = message.content;
    if (typeof content === "string") {
      composition.stringMessages += 1;
      const stringBucket: Bucket = isToolResultRole(message.role) ? "tool" : "text";
      buckets[stringBucket].blocks += 1;
      buckets[stringBucket].chars += content.length;
      composition.blockCount += 1;
    } else if (Array.isArray(content)) {
      if (content.length === 0) composition.emptyArrayMessages += 1;
      for (const block of content) {
        const bucket = isToolResultRole(message.role)
          ? "tool"
          : bucketOfType((block as { type?: unknown })?.type);
        buckets[bucket].blocks += 1;
        const chars = serializedLength(block);
        buckets[bucket].chars += chars;
        composition.blockCount += 1;
        if (
          bucket === "reasoning" &&
          composition.examples.length < 6 &&
          chars > 0
        ) {
          composition.examples.push(
            `reasoning block type=${String((block as { type?: unknown }).type)} chars=${chars}`,
          );
        }
      }
    }
    if (typeof message.reasoning_content === "string" && message.reasoning_content.length > 0) {
      composition.reasoningContentMessages += 1;
      composition.reasoningContentChars += message.reasoning_content.length;
    }
  }
  return composition;
}

function pct(part: number, total: number): string {
  return total === 0 ? "0.0%" : `${((part / total) * 100).toFixed(1)}%`;
}

function render(compositions: Composition[]): string {
  const lines: string[] = [];
  lines.push("=== lane-split offline assembly composition ===");
  lines.push(`snapshot=${SNAPSHOT} conversationId=${CONVERSATION_ID}`);
  for (const c of compositions) {
    const total = c.buckets.reasoning.chars + c.buckets.tool.chars +
      c.buckets.text.chars + c.buckets.other.chars;
    lines.push("");
    lines.push(`--- tokenBudget=${c.budget} ---`);
    lines.push(`messages=${c.messageCount} blocks=${c.blockCount} serializedChars=${total}`);
    lines.push("bucket | blocks | chars | share(blocks) | share(chars)");
    lines.push(
      `reasoning | ${c.buckets.reasoning.blocks} | ${c.buckets.reasoning.chars} | ` +
      `${pct(c.buckets.reasoning.blocks, c.blockCount)} | ${pct(c.buckets.reasoning.chars, total)}`,
    );
    lines.push(
      `tool      | ${c.buckets.tool.blocks} | ${c.buckets.tool.chars} | ` +
      `${pct(c.buckets.tool.blocks, c.blockCount)} | ${pct(c.buckets.tool.chars, total)}`,
    );
    lines.push(
      `text      | ${c.buckets.text.blocks} | ${c.buckets.text.chars} | ` +
      `${pct(c.buckets.text.blocks, c.blockCount)} | ${pct(c.buckets.text.chars, total)}`,
    );
    lines.push(
      `other     | ${c.buckets.other.blocks} | ${c.buckets.other.chars} | ` +
      `${pct(c.buckets.other.blocks, c.blockCount)} | ${pct(c.buckets.other.chars, total)}`,
    );
    lines.push(
      `stringMessages=${c.stringMessages} emptyArrayMessages=${c.emptyArrayMessages}`,
    );
    lines.push(
      `topLevel reasoning_content: messages=${c.reasoningContentMessages} chars=${c.reasoningContentChars}`,
    );
    lines.push(
      `REASONING IN CONTENT ARRAYS: ${c.buckets.reasoning.blocks > 0 ? "YES" : "NO"}`,
    );
    for (const example of c.examples) lines.push(`  example: ${example}`);
  }
  lines.push("");
  lines.push("=== end ===");
  return lines.join("\n") + "\n";
}

function renderReasoningComparison(off: Composition[], lowest: Composition[]): string {
  const lines: string[] = [];
  const totalOf = (c: Composition): number =>
    c.buckets.reasoning.chars + c.buckets.tool.chars + c.buckets.text.chars + c.buckets.other.chars;
  const referenceIndex = lowest.reduce(
    (best, candidate, index) => (candidate.budget > lowest[best].budget ? index : best),
    0,
  );
  const reference = lowest[referenceIndex];
  lines.push("");
  lines.push("=== flag off vs flag on (lane split, reasoning=lowest) ===");
  lines.push(
    "snapshot=" + SNAPSHOT + " conversationId=" + CONVERSATION_ID +
      " conversationCap=" +
      (CONVERSATION_CAP === undefined ? "default(65536)" : String(CONVERSATION_CAP)),
  );
  lines.push(
    "text reference (max budget, lowest): blocks=" +
      (reference ? reference.buckets.text.blocks : 0) +
      " chars=" +
      (reference ? reference.buckets.text.chars : 0),
  );
  for (let index = 0; index < lowest.length; index++) {
    const onComposition = lowest[index];
    const offComposition = off[index];
    const onTotal = totalOf(onComposition);
    const offTotal = totalOf(offComposition);
    lines.push("");
    lines.push("--- tokenBudget=" + onComposition.budget + " ---");
    lines.push(
      "[off   ] chars=" + offTotal +
        " reasoning=" + pct(offComposition.buckets.reasoning.chars, offTotal) +
        " tool=" + pct(offComposition.buckets.tool.chars, offTotal) +
        " text=" + pct(offComposition.buckets.text.chars, offTotal),
    );
    lines.push(
      "[lowest] chars=" + onTotal +
        " reasoning=" + pct(onComposition.buckets.reasoning.chars, onTotal) +
        " tool=" + pct(onComposition.buckets.tool.chars, onTotal) +
        " text=" + pct(onComposition.buckets.text.chars, onTotal),
    );
    lines.push(
      "  text kept vs reference: blocks=" +
        pct(onComposition.buckets.text.blocks, reference ? reference.buckets.text.blocks : 0) +
        " chars=" +
        pct(onComposition.buckets.text.chars, reference ? reference.buckets.text.chars : 0) +
        " | text chars off->lowest " + offComposition.buckets.text.chars + " -> " + onComposition.buckets.text.chars +
        " | total chars off->lowest " + offTotal + " -> " + onTotal,
    );
  }
  lines.push("");
  lines.push("=== end reasoning comparison ===");
  return lines.join("\n") + "\n";
}

function renderLaneSplitComparison(off: Composition[], on: Composition[]): string {
  const lines: string[] = [];
  const totalOf = (c: Composition): number =>
    c.buckets.reasoning.chars + c.buckets.tool.chars + c.buckets.text.chars + c.buckets.other.chars;
  const referenceIndex = on.reduce(
    (best, candidate, index) => (candidate.budget > on[best].budget ? index : best),
    0,
  );
  const reference = on[referenceIndex];
  lines.push("");
  lines.push("=== flag off vs flag on (lane split) ===");
  lines.push(
    "snapshot=" + SNAPSHOT + " conversationId=" + CONVERSATION_ID +
      " conversationCap=" +
      (CONVERSATION_CAP === undefined ? "default(65536)" : String(CONVERSATION_CAP)),
  );
  lines.push(
    "text reference (max budget, flag on): blocks=" +
      (reference ? reference.buckets.text.blocks : 0) +
      " chars=" +
      (reference ? reference.buckets.text.chars : 0),
  );
  for (let index = 0; index < on.length; index++) {
    const onComposition = on[index];
    const offComposition = off[index];
    const onTotal = totalOf(onComposition);
    const offTotal = totalOf(offComposition);
    lines.push("");
    lines.push("--- tokenBudget=" + onComposition.budget + " ---");
    lines.push(
      "[off] chars=" + offTotal +
        " reasoning=" + pct(offComposition.buckets.reasoning.chars, offTotal) +
        " tool=" + pct(offComposition.buckets.tool.chars, offTotal) +
        " text=" + pct(offComposition.buckets.text.chars, offTotal),
    );
    lines.push(
      "[on ] chars=" + onTotal +
        " reasoning=" + pct(onComposition.buckets.reasoning.chars, onTotal) +
        " tool=" + pct(onComposition.buckets.tool.chars, onTotal) +
        " text=" + pct(onComposition.buckets.text.chars, onTotal),
    );
    lines.push(
      "  text kept vs reference: blocks=" +
        pct(onComposition.buckets.text.blocks, reference ? reference.buckets.text.blocks : 0) +
        " chars=" +
        pct(onComposition.buckets.text.chars, reference ? reference.buckets.text.chars : 0) +
        " | tool chars off->on " + offComposition.buckets.tool.chars + " -> " + onComposition.buckets.tool.chars,
    );
  }
  lines.push("");
  lines.push("=== end lane-split comparison ===");
  return lines.join("\n") + "\n";
}

/**
 * Append a synthetic "latest user turn" to the copied snapshot.
 *
 * Real assembly runs when a new user message has just been ingested, so the
 * live conversation always ends with a user turn. These captured snapshots end
 * with tool/assistant turns and hold a single user message at ordinal 0, which
 * makes the assembler keep the WHOLE session as a protected fresh tail (nothing
 * is evictable). Appending this turn restores the assembly-time shape so the
 * two-budget policy is actually exercised. Opt in with LANE_SPLIT_APPEND_USER=1.
 */
function appendSyntheticUserTurn(
  db: ReturnType<typeof createLcmDatabaseConnection>,
  conversationId: number,
): void {
  const messageRow = db
    .prepare("SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM messages WHERE conversation_id = ?")
    .get(conversationId) as { maxSeq: number };
  const ordinalRow = db
    .prepare("SELECT COALESCE(MAX(ordinal), -1) AS maxOrdinal FROM context_items WHERE conversation_id = ?")
    .get(conversationId) as { maxOrdinal: number };
  const inserted = db
    .prepare(
      "INSERT INTO messages (conversation_id, seq, role, content, token_count) VALUES (?, ?, ?, ?, ?) RETURNING message_id",
    )
    .get(
      conversationId,
      messageRow.maxSeq + 1,
      "user",
      "[lane-split harness] synthetic latest user turn",
      10,
    ) as { message_id: number };
  db.prepare(
    "INSERT INTO context_items (conversation_id, ordinal, item_type, message_id) VALUES (?, ?, ?, ?)",
  ).run(conversationId, ordinalRow.maxOrdinal + 1, "message", inserted.message_id);
}

const snapshotAvailable = SNAPSHOT.length > 0 && existsSync(SNAPSHOT);

describe.skipIf(!snapshotAvailable)("lane-split offline assembly composition", () => {
  it(
    "rebuilds the assembled prompt from the DB snapshot and reports part_type composition",
    async () => {
      const workDir = mkdtempSync(join(tmpdir(), "lane-split-harness-"));
      const dbPath = join(workDir, "lcm.db");
      copyFileSync(SNAPSHOT, dbPath);
      for (const suffix of ["-wal", "-shm"]) {
        if (existsSync(`${SNAPSHOT}${suffix}`)) {
          copyFileSync(`${SNAPSHOT}${suffix}`, `${dbPath}${suffix}`);
        }
      }

      const db = createLcmDatabaseConnection(dbPath);
      try {
        if (process.env.LANE_SPLIT_APPEND_USER === "1") {
          appendSyntheticUserTurn(db, CONVERSATION_ID);
        }
        const conversationStore = new ConversationStore(db);
        const summaryStore = new SummaryStore(db);
        const assembler = new ContextAssembler(
          conversationStore,
          summaryStore,
          "UTC",
          { getActiveFocusBrief: async () => null },
          { warn: () => {} },
        );

        const compositions: Composition[] = [];
        const onCompositions: Composition[] = [];
        const lowestCompositions: Composition[] = [];
        const onLaneDebug: Array<
          { conversationTrimmed: boolean; longtextTrimmed: boolean } | undefined
        > = [];
        for (const budget of BUDGETS) {
          const input = {
            conversationId: CONVERSATION_ID,
            tokenBudget: budget,
            freshTailCount: FRESH_TAIL_COUNT,
          };
          const offResult = await assembler.assemble(input);
          const onResult = await assembler.assemble({
            ...input,
            laneSplitEnabled: true,
            laneConversationTokenCap: CONVERSATION_CAP,
          });
          compositions.push(
            analyze(budget, offResult.messages as unknown as Array<Record<string, unknown>>),
          );
          onCompositions.push(
            analyze(budget, onResult.messages as unknown as Array<Record<string, unknown>>),
          );
          onLaneDebug.push(
            onResult.debug?.laneSplit
              ? {
                  conversationTrimmed: onResult.debug.laneSplit.conversationTrimmed,
                  longtextTrimmed: onResult.debug.laneSplit.longtextTrimmed,
                }
              : undefined,
          );
          if (REASONING_MODE === "lowest") {
            const lowestResult = await assembler.assemble({
              ...input,
              laneSplitEnabled: true,
              laneConversationTokenCap: CONVERSATION_CAP,
              laneReasoningMode: "lowest",
            });
            lowestCompositions.push(
              analyze(
                budget,
                lowestResult.messages as unknown as Array<Record<string, unknown>>,
              ),
            );
          }
        }

        const report =
          render(compositions) +
          renderLaneSplitComparison(compositions, onCompositions) +
          (REASONING_MODE === "lowest"
            ? renderReasoningComparison(compositions, lowestCompositions)
            : "");
        mkdirSync(dirname(REPORT_PATH), { recursive: true });
        writeFileSync(REPORT_PATH, report, "utf8");
        // Keep the vitest output small; the full report is on disk.
        console.log(report.split("\n").slice(0, 34).join("\n"));

        // Acceptance (restated 2026-10-03, after the budget-ceiling fix).
        //
        // The original criterion was "retain 100% of the reference conversation
        // text at every tighter budget". That held only because a conversation
        // lane larger than the budget was emitted anyway — measured overshoot
        // was ~3x (an 8000-token budget produced ~23k tokens of output). The
        // budget must stay a hard ceiling, so the criterion is now:
        //   (a) flag-on never emits more than flag-off (off already respects
        //       the budget, so this pins the ceiling);
        //   (b) the conversation lane has priority: flag-on keeps at least as
        //       much conversation text as flag-off, and starves the tool lane
        //       first;
        //   (c) 100% conversation retention whenever the budget is large
        //       enough that the conversation lane is not trimmed.
        const referenceIndex = onCompositions.reduce(
          (best, candidate, index) =>
            candidate.budget > onCompositions[best].budget ? index : best,
          0,
        );
        const reference = onCompositions[referenceIndex];
        if (!reference) throw new Error("lane-split harness: no budget compositions");
        for (let index = 0; index < onCompositions.length; index++) {
          if (index === referenceIndex) continue;
          const on = onCompositions[index];
          const off = compositions[index];
          const total = (c: Composition) =>
            c.buckets.reasoning.chars + c.buckets.tool.chars +
            c.buckets.text.chars + c.buckets.other.chars;
          // (a) the budget stays a hard ceiling.
          expect(total(on)).toBeLessThanOrEqual(total(off));
          // (b) conversation priority, tool starved first.
          expect(on.buckets.text.chars).toBeGreaterThanOrEqual(off.buckets.text.chars);
          expect(on.buckets.tool.chars).toBeLessThanOrEqual(off.buckets.tool.chars);
          // (c) full retention unless the budget itself forced a trim.
          const lane = onLaneDebug[index];
          if (!lane?.conversationTrimmed) {
            expect(on.buckets.text.chars).toBe(reference.buckets.text.chars);
          }
          if (on.buckets.tool.chars < reference.buckets.tool.chars) {
            expect(lane?.longtextTrimmed).toBe(true);
          }
        }
        expect(compositions.length).toBe(BUDGETS.length);
      } finally {
        closeLcmConnection(db);
      }
    },
    300_000,
  );
});

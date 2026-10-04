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
        for (const budget of BUDGETS) {
          const result = await assembler.assemble({
            conversationId: CONVERSATION_ID,
            tokenBudget: budget,
            freshTailCount: 64,
          });
          compositions.push(
            analyze(budget, result.messages as unknown as Array<Record<string, unknown>>),
          );
        }

        const report = render(compositions);
        mkdirSync(dirname(REPORT_PATH), { recursive: true });
        writeFileSync(REPORT_PATH, report, "utf8");
        // Keep the vitest output small; the full report is on disk.
        console.log(report.split("\n").slice(0, 24).join("\n"));
        expect(compositions.length).toBe(BUDGETS.length);
      } finally {
        closeLcmConnection(db);
      }
    },
    300_000,
  );
});

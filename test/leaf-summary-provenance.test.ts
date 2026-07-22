// Leaf-summary provenance: the summarizer source text must carry each message's role.
// Without it a tool result quoting another conversation is indistinguishable from a
// user instruction, and the summarizer can promote quoted material to current intent.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { CompactionEngine } from "../src/compaction.js";
import type { MessageRole } from "../src/store/conversation-store.js";
import {
  createMockConversationStore,
  createMockSummaryStore,
  estimateTokens,
  CONV_ID,
  ingestMessages,
  wireStores,
  defaultCompactionConfig,
} from "./integration-helpers.js";

// leafMinFanout 8 + freshTailCount 4: seed enough that a leaf pass actually fires.
const SEED_COUNT = 16;

describe("leaf summary source text provenance", () => {
  let convStore: ReturnType<typeof createMockConversationStore>;
  let sumStore: ReturnType<typeof createMockSummaryStore>;
  let compactionEngine: CompactionEngine;

  beforeEach(() => {
    convStore = createMockConversationStore();
    sumStore = createMockSummaryStore();
    wireStores(convStore, sumStore);
    compactionEngine = new CompactionEngine(
      convStore as any,
      sumStore as any,
      defaultCompactionConfig,
    );
  });

  async function captureSourceText(opts: {
    contentFn: (i: number) => string;
    roleFn: (i: number) => MessageRole;
  }): Promise<string> {
    await ingestMessages(convStore, sumStore, SEED_COUNT, {
      contentFn: opts.contentFn,
      roleFn: opts.roleFn,
      tokenCountFn: (_i, content) => estimateTokens(content),
    });

    let captured = "";
    const summarize = vi.fn(async (text: string) => {
      if (!captured) captured = text;
      return "summary";
    });
    const result = await compactionEngine.compact({
      conversationId: CONV_ID,
      tokenBudget: 10_000,
      summarize,
      force: true,
    });
    expect(result.actionTaken).toBe(true);
    expect(captured).not.toBe("");
    return captured;
  }

  it("distinguishes identical text arriving under different roles", async () => {
    const shared = "Switch the current workstream to DTC org design.";
    const sourceText = await captureSourceText({
      contentFn: () => shared,
      roleFn: (i) => (i % 2 === 0 ? "user" : "tool"),
    });

    // The same sentence appears under both roles; only provenance can tell the
    // operator's instruction apart from material a tool fetched elsewhere.
    expect(sourceText.toLowerCase()).toContain("user");
    expect(sourceText.toLowerCase()).toContain("tool");
  });

  it("labels every role it emits", async () => {
    const roles: MessageRole[] = ["user", "assistant", "tool", "system"];
    const sourceText = await captureSourceText({
      contentFn: (i) => `message ${i}`,
      roleFn: (i) => roles[i % roles.length]!,
    });

    for (const role of roles) {
      expect(sourceText.toLowerCase()).toContain(role);
    }
  });

  it("keeps the role marker out of the message body", async () => {
    const sourceText = await captureSourceText({
      contentFn: (i) => `fetched material ${i}`,
      roleFn: () => "tool",
    });

    // The marker belongs to the header line, not the content line, so a summarizer
    // reading line-by-line cannot mistake it for quoted text.
    const lines = sourceText.split("\n");
    const bodyIndex = lines.findIndex((l) => l.includes("fetched material"));
    expect(bodyIndex).toBeGreaterThan(0);

    const headerLine = lines[bodyIndex - 1]!;
    expect(headerLine.toLowerCase()).toContain("tool");
    expect(lines[bodyIndex]!.toLowerCase()).not.toContain("tool");
  });
});

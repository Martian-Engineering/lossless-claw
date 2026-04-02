import { describe, it, expect, vi } from "vitest";
import { ContextAssembler, type PinnedFileEntry } from "../src/assembler.js";
import type { ConversationStore } from "../src/store/conversation-store.js";
import type { SummaryStore, ContextItemRecord } from "../src/store/summary-store.js";
import { resolveLcmConfig } from "../src/db/config.js";

// ── Minimal store stubs ──────────────────────────────────────────────────────

function stubConversationStore(overrides?: Partial<ConversationStore>): ConversationStore {
  return {
    getMessageById: vi.fn().mockResolvedValue(null),
    getMessageParts: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as ConversationStore;
}

function stubSummaryStore(contextItems: ContextItemRecord[] = []): SummaryStore {
  return {
    getContextItems: vi.fn().mockResolvedValue(contextItems),
    getSummary: vi.fn().mockResolvedValue(null),
    getSummaryParents: vi.fn().mockResolvedValue([]),
  } as unknown as SummaryStore;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("pinnedFiles", () => {
  it("pinned files appear in assembled context as user messages", async () => {
    const pinnedFiles: PinnedFileEntry[] = [
      { path: "FLEET.md", content: "# Fleet Protocol\nFollow these rules." },
      { path: "BOUNDARIES.md", content: "# Boundaries\nStay within scope." },
    ];

    const assembler = new ContextAssembler(
      stubConversationStore(),
      stubSummaryStore([]),
    );

    const result = await assembler.assemble({
      conversationId: 1,
      tokenBudget: 100_000,
      pinnedFiles,
    });

    // Pinned files should be the only messages (no context items in DB)
    expect(result.messages).toHaveLength(2);

    const msg0 = result.messages[0] as { role: string; content: string };
    expect(msg0.role).toBe("user");
    expect(msg0.content).toContain('<pinned_file path="FLEET.md">');
    expect(msg0.content).toContain("# Fleet Protocol");
    expect(msg0.content).toContain("</pinned_file>");

    const msg1 = result.messages[1] as { role: string; content: string };
    expect(msg1.role).toBe("user");
    expect(msg1.content).toContain('<pinned_file path="BOUNDARIES.md">');
    expect(msg1.content).toContain("# Boundaries");
  });

  it("pinned files are not subject to eviction", async () => {
    const pinnedFiles: PinnedFileEntry[] = [
      { path: "FLEET.md", content: "A".repeat(400) }, // ~100 tokens
    ];

    // Create context items that fill most of the budget
    const items: ContextItemRecord[] = [
      { ordinal: 1, itemType: "message", messageId: 1, summaryId: null, conversationId: 1 },
      { ordinal: 2, itemType: "message", messageId: 2, summaryId: null, conversationId: 1 },
    ];

    const assembler = new ContextAssembler(
      stubConversationStore({
        getMessageById: vi.fn().mockImplementation(async (id: number) => ({
          messageId: id,
          role: "user" as const,
          content: "B".repeat(200), // ~50 tokens each
          conversationId: 1,
          createdAt: new Date(),
        })),
        getMessageParts: vi.fn().mockResolvedValue([]),
      }),
      stubSummaryStore(items),
    );

    // Budget is tight: pinned file (100t) + 2 messages (50t each) = 200t
    // With a budget of 200, everything should fit
    const result = await assembler.assemble({
      conversationId: 1,
      tokenBudget: 200,
      pinnedFiles,
      freshTailCount: 1, // protect only the last message
    });

    // Pinned file should always be present
    const pinnedMsg = result.messages[0] as { role: string; content: string };
    expect(pinnedMsg.content).toContain('<pinned_file path="FLEET.md">');

    // With very tight budget (only enough for pinned + fresh tail),
    // the evictable message should be dropped
    const tightResult = await assembler.assemble({
      conversationId: 1,
      tokenBudget: 160, // pinned (100t) + 1 fresh tail msg (50t) = 150t, evictable doesn't fit
      pinnedFiles,
      freshTailCount: 1,
    });

    // Pinned file is still present
    const tightPinned = tightResult.messages[0] as { role: string; content: string };
    expect(tightPinned.content).toContain('<pinned_file path="FLEET.md">');

    // Only fresh tail message remains (evictable one was dropped)
    // messages = [pinned, fresh_tail_msg]
    expect(tightResult.messages).toHaveLength(2);
  });

  it("missing pinned files are handled gracefully (empty array)", async () => {
    const assembler = new ContextAssembler(
      stubConversationStore(),
      stubSummaryStore([]),
    );

    // No pinned files provided
    const result = await assembler.assemble({
      conversationId: 1,
      tokenBudget: 100_000,
      pinnedFiles: [],
    });

    expect(result.messages).toHaveLength(0);
    expect(result.estimatedTokens).toBe(0);
  });

  it("token budget accounts for pinned file sizes", async () => {
    const content = "X".repeat(4000); // ~1000 tokens
    const pinnedFiles: PinnedFileEntry[] = [
      { path: "big.md", content },
    ];

    const assembler = new ContextAssembler(
      stubConversationStore(),
      stubSummaryStore([]),
    );

    const result = await assembler.assemble({
      conversationId: 1,
      tokenBudget: 100_000,
      pinnedFiles,
    });

    // Token estimate should include the pinned file
    expect(result.estimatedTokens).toBeGreaterThan(900);
    expect(result.estimatedTokens).toBeLessThan(1100);
  });
});

describe("pinnedFiles config", () => {
  it("resolves pinnedFiles from plugin config", () => {
    const config = resolveLcmConfig({}, {
      pinnedFiles: ["FLEET.md", "FLEET-BOUNDARIES.md"],
    });
    expect(config.pinnedFiles).toEqual(["FLEET.md", "FLEET-BOUNDARIES.md"]);
  });

  it("defaults pinnedFiles to empty array", () => {
    const config = resolveLcmConfig({}, {});
    expect(config.pinnedFiles).toEqual([]);
  });

  it("handles comma-separated string for pinnedFiles", () => {
    const config = resolveLcmConfig({}, {
      pinnedFiles: "FLEET.md, BOUNDARIES.md",
    });
    expect(config.pinnedFiles).toEqual(["FLEET.md", "BOUNDARIES.md"]);
  });
});

describe("pinnedFilesPerAgent config", () => {
  it("resolves per-agent pinned files from plugin config", () => {
    const config = resolveLcmConfig({}, {
      pinnedFilesPerAgent: {
        athena: ["system/subject-guides.md", "system/standing-rules.md"],
      },
    });
    expect(config.pinnedFilesPerAgent).toEqual({
      athena: ["system/subject-guides.md", "system/standing-rules.md"],
    });
  });

  it("defaults pinnedFilesPerAgent to empty object", () => {
    const config = resolveLcmConfig({}, {});
    expect(config.pinnedFilesPerAgent).toEqual({});
  });

  it("ignores non-object pinnedFilesPerAgent values", () => {
    const config = resolveLcmConfig({}, {
      pinnedFilesPerAgent: "not-an-object",
    });
    expect(config.pinnedFilesPerAgent).toEqual({});
  });

  it("ignores array pinnedFilesPerAgent values", () => {
    const config = resolveLcmConfig({}, {
      pinnedFilesPerAgent: ["a", "b"],
    });
    expect(config.pinnedFilesPerAgent).toEqual({});
  });

  it("handles multiple agents", () => {
    const config = resolveLcmConfig({}, {
      pinnedFilesPerAgent: {
        athena: ["a.md"],
        brunelleschi: ["b.md", "c.md"],
      },
    });
    expect(config.pinnedFilesPerAgent).toEqual({
      athena: ["a.md"],
      brunelleschi: ["b.md", "c.md"],
    });
  });

  it("filters out non-string entries within per-agent arrays", () => {
    const config = resolveLcmConfig({}, {
      pinnedFilesPerAgent: {
        athena: ["valid.md", 123, null, "also-valid.md"],
      },
    });
    expect(config.pinnedFilesPerAgent).toEqual({
      athena: ["valid.md", "also-valid.md"],
    });
  });
});

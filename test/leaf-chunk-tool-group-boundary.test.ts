// Routine leaf chunks end only at tool-group boundaries (#861).
import { describe, expect, it, vi } from "vitest";
import { CompactionEngine } from "../src/compaction.js";
import type { ContextItemRecord } from "../src/store/summary-store.js";
import type { MessageRole } from "../src/store/conversation-store.js";
import {
  createMockConversationStore,
  createMockSummaryStore,
  CONV_ID,
  wireStores,
  defaultCompactionConfig,
} from "./integration-helpers.js";

type RowSpec =
  | { label: string; role: MessageRole; tokens?: number; calls?: Array<string | null>; result?: string | null }
  | { summary: string };

/** Build stores whose context holds the given rows, with real tool parts. */
async function setup(
  rows: RowSpec[],
  config: { freshTailCount: number; leafChunkTokens: number },
) {
  const convStore = createMockConversationStore();
  const sumStore = createMockSummaryStore();
  wireStores(convStore, sumStore);
  await convStore.createConversation({ sessionId: "tool-group-session" });
  const labels = new Map<number, string>();
  let seq = 0;
  for (const row of rows) {
    if ("summary" in row) {
      await sumStore.appendContextSummary(CONV_ID, row.summary);
      continue;
    }
    const message = await convStore.createMessage({
      conversationId: CONV_ID,
      seq: ++seq,
      role: row.role,
      content: row.label,
      tokenCount: row.tokens ?? 100,
    });
    labels.set(message.messageId, row.label);
    const parts = row.calls
      ? row.calls.map((toolCallId, ordinal) => ({ partType: "tool" as const, ordinal, toolCallId }))
      : row.result !== undefined
        ? [{ partType: "tool" as const, ordinal: 0, toolCallId: row.result }]
        : [];
    if (parts.length > 0) {
      await convStore.createMessageParts(
        message.messageId,
        parts.map((part) => ({ ...part, sessionId: "tool-group-session" })),
      );
    }
    await sumStore.appendContextMessage(CONV_ID, message.messageId);
  }
  const engine = new CompactionEngine(convStore as any, sumStore as any, {
    ...defaultCompactionConfig,
    ...config,
  });
  const select = async (): Promise<string[]> => {
    const chunk = await (engine as any).selectOldestLeafChunk(CONV_ID);
    return chunk.items.map((item: ContextItemRecord) => labels.get(item.messageId!)!);
  };
  const rawLabels = async (): Promise<string[]> =>
    (await sumStore.getContextItems(CONV_ID))
      .filter((item) => item.itemType === "message")
      .map((item) => labels.get(item.messageId!)!);
  return { engine, convStore, sumStore, select, rawLabels };
}

const user = (label: string, tokens = 100): RowSpec => ({ label, role: "user", tokens });
const text = (label: string, tokens = 100): RowSpec => ({ label, role: "assistant", tokens });
const call = (label: string, calls: Array<string | null>, tokens = 100): RowSpec => ({
  label,
  role: "assistant",
  tokens,
  calls,
});
const result = (label: string, id: string | null, tokens = 100): RowSpec => ({
  label,
  role: "tool",
  tokens,
  result: id,
});

describe("routine leaf chunks end at tool-group boundaries", () => {
  it("ends the chunk before an assistant call whose result the token cut excludes", async () => {
    const { select } = await setup(
      [user("u1"), call("a1", ["c1"]), result("t1", "c1"), user("u2"), text("x"), user("u3")],
      { freshTailCount: 2, leafChunkTokens: 250 },
    );
    expect(await select()).toEqual(["u1"]);
  });

  it("keeps parallel calls together with all of their results", async () => {
    const { select } = await setup(
      [
        user("u1"),
        call("a1", ["c1", "c2", "c3"]),
        result("t1", "c1"),
        result("t2", "c2"),
        result("t3", "c3"),
        user("u2"),
        text("x"),
        user("u3"),
      ],
      { freshTailCount: 2, leafChunkTokens: 300 },
    );
    expect(await select()).toEqual(["u1"]);
  });

  it("takes a whole group over the threshold at the chunk start", async () => {
    const { select } = await setup(
      [call("a1", ["c1", "c2"]), result("t1", "c1"), result("t2", "c2"), user("u2"), text("x")],
      { freshTailCount: 2, leafChunkTokens: 150 },
    );
    expect(await select()).toEqual(["a1", "t1", "t2"]);
  });

  it("returns an empty chunk when the start group runs into the fresh tail", async () => {
    const { select } = await setup(
      [call("a1", ["c1", "c2"]), result("t1", "c1"), result("t2", "c2")],
      { freshTailCount: 1, leafChunkTokens: 150 },
    );
    expect(await select()).toEqual([]);
  });

  it("leaves out a call whose result starts the fresh tail", async () => {
    const { select } = await setup(
      [user("u1"), text("x"), call("a1", ["c1"]), result("t1", "c1"), user("u2"), text("y")],
      { freshTailCount: 3, leafChunkTokens: 10_000 },
    );
    expect(await select()).toEqual(["u1", "x"]);
  });

  it("treats a call with a missing result as closed and keeps making progress", async () => {
    const { engine, rawLabels } = await setup(
      [
        user("u1"),
        call("a1", ["missing"]),
        user("u2"),
        call("a2", ["c2"]),
        result("t2", "c2"),
        user("u3"),
        text("x"),
        user("u4"),
      ],
      { freshTailCount: 2, leafChunkTokens: 400 },
    );
    const summarize = vi.fn(async () => "summary");
    const compact = () =>
      engine.compactLeaf({ conversationId: CONV_ID, tokenBudget: 100_000, summarize, force: true });

    expect((await compact()).actionTaken).toBe(true);
    expect(await rawLabels()).toEqual(["a2", "t2", "u3", "x", "u4"]);
    expect((await compact()).actionTaken).toBe(true);
    expect(await rawLabels()).toEqual(["x", "u4"]);
  });

  it("groups legacy null tool-call ids by adjacency, deterministically", async () => {
    const rows = [
      user("u1"),
      call("a1", [null]),
      result("t1", null),
      result("t2", null),
      user("u2"),
      text("x"),
      user("u3"),
    ];
    const first = await setup(rows, { freshTailCount: 2, leafChunkTokens: 300 });
    const second = await setup(rows, { freshTailCount: 2, leafChunkTokens: 300 });
    expect(await first.select()).toEqual(["u1"]);
    expect(await second.select()).toEqual(await first.select());
  });
});

/** Reference copy of selectOldestLeafChunk at 51c3c90b, before tool-group boundaries. */
async function referenceSelectOldestLeafChunk(
  engine: any,
  conversationId: number,
  leafChunkTokensOverride?: number,
  freshTailCountOverride?: number,
  afterOrdinal?: number,
): Promise<ContextItemRecord[]> {
  const contextItems: ContextItemRecord[] = await engine.getContextItemsCached(conversationId);
  const freshTailOrdinal = await engine.resolveFreshTailOrdinal(contextItems, freshTailCountOverride);
  const threshold = engine.resolveLeafChunkTokens(leafChunkTokensOverride);
  const chunk: ContextItemRecord[] = [];
  let chunkTokens = 0;
  let started = false;
  for (const item of contextItems) {
    if (item.ordinal >= freshTailOrdinal) break;
    if (afterOrdinal !== undefined && item.ordinal <= afterOrdinal) continue;
    if (!started) {
      if (item.itemType !== "message" || item.messageId == null) continue;
      started = true;
    } else if (item.itemType !== "message" || item.messageId == null) {
      break;
    }
    if (item.messageId == null) continue;
    const messageTokens = await engine.getMessageTokenCount(item.messageId);
    if (chunk.length > 0 && chunkTokens + messageTokens > threshold) break;
    chunk.push(item);
    chunkTokens += messageTokens;
    if (chunkTokens >= threshold) break;
  }
  return chunk;
}

/** Deterministic PRNG so the generated sequences are reproducible. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let next = Math.imul(state ^ (state >>> 15), 1 | state);
    next = (next + Math.imul(next ^ (next >>> 7), 61 | next)) ^ next;
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

describe("routine leaf chunk selection without tool messages", () => {
  it("matches the previous selection over 40 seeded sequences", async () => {
    const random = mulberry32(861);
    const roles: MessageRole[] = ["user", "assistant", "system"];
    for (let sample = 0; sample < 40; sample++) {
      const length = 5 + Math.floor(random() * 20);
      const rows: RowSpec[] = [];
      for (let index = 0; index < length; index++) {
        if (random() < 0.15) {
          rows.push({ summary: `sum_${sample}_${index}` });
          continue;
        }
        rows.push({
          label: `m${index}`,
          role: roles[Math.floor(random() * roles.length)]!,
          tokens: 1 + Math.floor(random() * 300),
        });
      }
      const leafChunkTokens = 50 + Math.floor(random() * 750);
      const freshTailCount = Math.floor(random() * 6);
      const afterOrdinal = random() < 0.3 ? Math.floor(random() * length) : undefined;
      const { engine } = await setup(rows, { freshTailCount: 4, leafChunkTokens: 20_000 });
      const actual = await (engine as any).selectOldestLeafChunk(
        CONV_ID,
        leafChunkTokens,
        freshTailCount,
        afterOrdinal,
      );
      const expected = await referenceSelectOldestLeafChunk(
        engine,
        CONV_ID,
        leafChunkTokens,
        freshTailCount,
        afterOrdinal,
      );
      expect(actual.items, `sample ${sample}`).toEqual(expected);
    }
  });
});

import { describe, it, expect, vi } from "vitest";

import { BatchDeduplicator } from "../src/batch-dedup.js";
import type { ConversationStore } from "../src/store/conversation-store.js";
import { buildMessageIdentityHash } from "../src/store/message-identity.js";
import type { SummaryStore } from "../src/store/summary-store.js";
import { makeMessage } from "./helpers.js";

function makeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/**
 * Drive alignRuntimeBatchAgainstCoveredFrontier past the tail-alignment loop
 * (empty covered frontier) so it reaches the persisted-identity overlap count,
 * with hasMessage answers supplied from a queue so the test controls N (overlaps)
 * versus M (batch length) exactly. Persisted counts separately control whether
 * duplicate incoming identities are fully covered by distinct persisted rows.
 */
function makeDedup(
  hasMessageQueue: boolean[],
  persistedCounts: Array<{ role: "user" | "assistant"; content: string; count: number }> = [],
) {
  const log = makeLog();
  const countsByIdentity = new Map(
    persistedCounts.map((entry) => [
      `${entry.role}\0${buildMessageIdentityHash(entry.role, entry.content)}`,
      entry.count,
    ]),
  );
  const conversationStore = {
    getConversationForSession: async () => ({ conversationId: 1 }),
    getLastMessages: async () => [],
    getRecentMessageIdentityHashes: async () => [],
    hasMessage: vi.fn(async () => hasMessageQueue.shift() ?? false),
    countMessagesByIdentityHash: vi.fn(
      async (_conversationId: number, role: "user" | "assistant", identityHash: string) =>
        countsByIdentity.get(`${role}\0${identityHash}`) ?? 0,
    ),
  } as unknown as ConversationStore;
  const dedup = new BatchDeduplicator(
    conversationStore,
    {} as unknown as SummaryStore,
    "/tmp/lcm-frontier-loglevel-test",
    { log },
  );
  return { dedup, log };
}

describe("batch-dedup frontier-overlap fail-closed log level", () => {
  it("logs at debug, not warn, when the runtime batch is fully covered (N==M)", async () => {
    const { dedup, log } = makeDedup([true, true], [
      { role: "user", content: "u1", count: 1 },
      { role: "assistant", content: "a1", count: 1 },
    ]);
    const batch = [
      makeMessage({ role: "user", content: "u1" }),
      makeMessage({ role: "assistant", content: "a1" }),
    ];

    const result = await dedup.alignRuntimeBatchAgainstCoveredFrontier("s1", undefined, batch);

    expect(result).toEqual([]);
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining("overlaps persisted history (2/2)"),
    );
  });

  it("keeps warn on partial overlap (N<M) so the suspicious mixed case stays visible", async () => {
    const { dedup, log } = makeDedup([true, true, false], [
      { role: "user", content: "u1", count: 1 },
      { role: "assistant", content: "a1", count: 1 },
    ]);
    const batch = [
      makeMessage({ role: "user", content: "u1" }),
      makeMessage({ role: "assistant", content: "a1" }),
      makeMessage({ role: "user", content: "u2" }),
    ];

    const result = await dedup.alignRuntimeBatchAgainstCoveredFrontier("s2", undefined, batch);

    expect(result).toEqual([]);
    expect(log.debug).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("overlaps persisted history (2/3)"),
    );
  });

  it("keeps warn when duplicate incoming rows outnumber persisted occurrences", async () => {
    const { dedup, log } = makeDedup([true, true], [
      { role: "user", content: "repeat", count: 1 },
    ]);
    const batch = [
      makeMessage({ role: "user", content: "repeat" }),
      makeMessage({ role: "user", content: "repeat" }),
    ];

    const result = await dedup.alignRuntimeBatchAgainstCoveredFrontier("s2", undefined, batch);

    expect(result).toEqual([]);
    expect(log.debug).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("overlaps persisted history (2/2)"),
    );
  });

  it("ingests the full batch with no overlap log when nothing is already persisted", async () => {
    const { dedup, log } = makeDedup([false]);
    const batch = [makeMessage({ role: "user", content: "fresh" })];

    const result = await dedup.alignRuntimeBatchAgainstCoveredFrontier("s3", undefined, batch);

    expect(result).toEqual(batch);
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.debug).not.toHaveBeenCalled();
  });
});

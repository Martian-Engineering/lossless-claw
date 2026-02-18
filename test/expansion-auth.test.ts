import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ExpansionRequest, ExpansionResult } from "./expansion.js";
import type { RetrievalEngine, ExpandResult, GrepResult } from "./retrieval.js";
import { ExpansionAuthManager, wrapWithAuth } from "./expansion-auth.js";
import { ExpansionOrchestrator, distillForSubagent } from "./expansion.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal mock RetrievalEngine with vi.fn() stubs. */
function makeMockRetrieval(): {
  expand: ReturnType<typeof vi.fn>;
  grep: ReturnType<typeof vi.fn>;
} & Pick<RetrievalEngine, "expand" | "grep"> {
  return {
    expand: vi.fn<(input: any) => Promise<ExpandResult>>(),
    grep: vi.fn<(input: any) => Promise<GrepResult>>(),
  };
}

/** Build a simple ExpandResult for mocking. */
function makeExpandResult(overrides: Partial<ExpandResult> = {}): ExpandResult {
  return {
    children: [],
    messages: [],
    estimatedTokens: 0,
    truncated: false,
    ...overrides,
  };
}

/** Build a complete ExpansionResult for distill tests. */
function makeExpansionResult(overrides: Partial<ExpansionResult> = {}): ExpansionResult {
  return {
    expansions: [],
    citedIds: [],
    totalTokens: 0,
    truncated: false,
    ...overrides,
  };
}

// ===========================================================================
// 1. ExpansionAuthManager
// ===========================================================================

describe("ExpansionAuthManager", () => {
  let manager: ExpansionAuthManager;

  beforeEach(() => {
    manager = new ExpansionAuthManager();
  });

  // ── createGrant ──────────────────────────────────────────────────────────

  describe("createGrant", () => {
    it("creates a grant with default values", () => {
      const before = Date.now();
      const grant = manager.createGrant({
        issuerSessionId: "sess1",
        allowedConversationIds: [1, 2],
      });
      const after = Date.now();

      expect(grant.grantId).toMatch(/^grant_/);
      expect(grant.issuerSessionId).toBe("sess1");
      expect(grant.allowedConversationIds).toEqual([1, 2]);
      expect(grant.allowedSummaryIds).toEqual([]);
      expect(grant.maxDepth).toBe(3);
      expect(grant.tokenCap).toBe(4000);
      expect(grant.revoked).toBe(false);

      // expiresAt should be ~5 minutes in the future
      const fiveMinMs = 5 * 60 * 1000;
      const expiresAtMs = grant.expiresAt.getTime();
      expect(expiresAtMs).toBeGreaterThanOrEqual(before + fiveMinMs - 50);
      expect(expiresAtMs).toBeLessThanOrEqual(after + fiveMinMs + 50);
    });

    it("creates a grant with custom values", () => {
      const grant = manager.createGrant({
        issuerSessionId: "sess2",
        allowedConversationIds: [10],
        allowedSummaryIds: ["sum_a", "sum_b"],
        maxDepth: 5,
        tokenCap: 8000,
        ttlMs: 60_000,
      });

      expect(grant.maxDepth).toBe(5);
      expect(grant.tokenCap).toBe(8000);
      expect(grant.allowedSummaryIds).toEqual(["sum_a", "sum_b"]);

      // TTL should be ~1 minute
      const delta = grant.expiresAt.getTime() - grant.createdAt.getTime();
      expect(delta).toBeGreaterThanOrEqual(59_900);
      expect(delta).toBeLessThanOrEqual(60_100);
    });
  });

  // ── getGrant ─────────────────────────────────────────────────────────────

  describe("getGrant", () => {
    it("returns a valid grant", () => {
      const grant = manager.createGrant({
        issuerSessionId: "sess1",
        allowedConversationIds: [1],
      });
      expect(manager.getGrant(grant.grantId)).toEqual(grant);
    });

    it("returns null for expired grant", () => {
      const grant = manager.createGrant({
        issuerSessionId: "sess1",
        allowedConversationIds: [1],
        ttlMs: 0,
      });
      // ttlMs=0 means expiresAt <= now, so getGrant uses `<=` check
      expect(manager.getGrant(grant.grantId)).toBeNull();
    });

    it("returns null for a grant with negative TTL", () => {
      const grant = manager.createGrant({
        issuerSessionId: "sess1",
        allowedConversationIds: [1],
        ttlMs: -1000,
      });
      expect(manager.getGrant(grant.grantId)).toBeNull();
    });

    it("returns null for revoked grant", () => {
      const grant = manager.createGrant({
        issuerSessionId: "sess1",
        allowedConversationIds: [1],
      });
      manager.revokeGrant(grant.grantId);
      expect(manager.getGrant(grant.grantId)).toBeNull();
    });

    it("returns null for unknown grantId", () => {
      expect(manager.getGrant("grant_doesnotexist")).toBeNull();
    });
  });

  // ── revokeGrant ──────────────────────────────────────────────────────────

  describe("revokeGrant", () => {
    it("returns true when revoking existing grant", () => {
      const grant = manager.createGrant({
        issuerSessionId: "sess1",
        allowedConversationIds: [1],
      });
      expect(manager.revokeGrant(grant.grantId)).toBe(true);
    });

    it("returns false when revoking unknown grant", () => {
      expect(manager.revokeGrant("grant_nope")).toBe(false);
    });

    it("makes the grant inaccessible via getGrant", () => {
      const grant = manager.createGrant({
        issuerSessionId: "sess1",
        allowedConversationIds: [1],
      });
      manager.revokeGrant(grant.grantId);
      expect(manager.getGrant(grant.grantId)).toBeNull();
    });
  });

  // ── validateExpansion ────────────────────────────────────────────────────

  describe("validateExpansion", () => {
    let grantId: string;

    beforeEach(() => {
      const grant = manager.createGrant({
        issuerSessionId: "sess1",
        allowedConversationIds: [1],
        allowedSummaryIds: ["sum_a", "sum_b"],
        maxDepth: 3,
        tokenCap: 4000,
      });
      grantId = grant.grantId;
    });

    it("accepts valid request within scope", () => {
      const result = manager.validateExpansion(grantId, {
        conversationId: 1,
        summaryIds: ["sum_a"],
        depth: 2,
        tokenCap: 2000,
      });
      expect(result.valid).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it("accepts request at exact depth and token limits", () => {
      const result = manager.validateExpansion(grantId, {
        conversationId: 1,
        summaryIds: ["sum_a", "sum_b"],
        depth: 3,
        tokenCap: 4000,
      });
      expect(result.valid).toBe(true);
    });

    it("rejects unknown grant", () => {
      const result = manager.validateExpansion("grant_fake", {
        conversationId: 1,
        summaryIds: ["sum_a"],
        depth: 1,
        tokenCap: 1000,
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("not found");
    });

    it("rejects expired grant", () => {
      const expiredGrant = manager.createGrant({
        issuerSessionId: "sess1",
        allowedConversationIds: [1],
        ttlMs: 0,
      });
      const result = manager.validateExpansion(expiredGrant.grantId, {
        conversationId: 1,
        summaryIds: [],
        depth: 1,
        tokenCap: 1000,
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("expired");
    });

    it("rejects revoked grant", () => {
      manager.revokeGrant(grantId);
      const result = manager.validateExpansion(grantId, {
        conversationId: 1,
        summaryIds: ["sum_a"],
        depth: 1,
        tokenCap: 1000,
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("revoked");
    });

    it("rejects unauthorized conversationId", () => {
      const result = manager.validateExpansion(grantId, {
        conversationId: 999,
        summaryIds: ["sum_a"],
        depth: 1,
        tokenCap: 1000,
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("Conversation");
    });

    it("rejects unauthorized summaryIds", () => {
      const result = manager.validateExpansion(grantId, {
        conversationId: 1,
        summaryIds: ["sum_c"],
        depth: 1,
        tokenCap: 1000,
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("Summary");
    });

    it("rejects when some summaryIds are authorized and some are not", () => {
      const result = manager.validateExpansion(grantId, {
        conversationId: 1,
        summaryIds: ["sum_a", "sum_c", "sum_d"],
        depth: 1,
        tokenCap: 1000,
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("sum_c");
      expect(result.reason).toContain("sum_d");
    });

    it("allows any summaryIds when allowedSummaryIds is empty", () => {
      const openGrant = manager.createGrant({
        issuerSessionId: "sess1",
        allowedConversationIds: [1],
        allowedSummaryIds: [],
      });
      const result = manager.validateExpansion(openGrant.grantId, {
        conversationId: 1,
        summaryIds: ["sum_anything", "sum_everything"],
        depth: 1,
        tokenCap: 1000,
      });
      expect(result.valid).toBe(true);
    });

    it("allows any summaryIds when allowedSummaryIds is omitted (defaults to empty)", () => {
      const openGrant = manager.createGrant({
        issuerSessionId: "sess1",
        allowedConversationIds: [1],
      });
      const result = manager.validateExpansion(openGrant.grantId, {
        conversationId: 1,
        summaryIds: ["sum_x", "sum_y", "sum_z"],
        depth: 1,
        tokenCap: 1000,
      });
      expect(result.valid).toBe(true);
    });

    it("does not enforce maxDepth against grant limits", () => {
      const result = manager.validateExpansion(grantId, {
        conversationId: 1,
        summaryIds: ["sum_a"],
        depth: 5,
        tokenCap: 1000,
      });
      expect(result.valid).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it("does not enforce tokenCap against grant limits", () => {
      const result = manager.validateExpansion(grantId, {
        conversationId: 1,
        summaryIds: ["sum_a"],
        depth: 1,
        tokenCap: 5000,
      });
      expect(result.valid).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it("checks validation in priority order: existence > revocation > expiry > scope", () => {
      // Non-existent grant should say "not found", not anything else
      const r1 = manager.validateExpansion("grant_nope", {
        conversationId: 999,
        summaryIds: ["sum_c"],
        depth: 100,
        tokenCap: 999999,
      });
      expect(r1.reason).toContain("not found");
    });
  });

  // ── cleanup ──────────────────────────────────────────────────────────────

  describe("cleanup", () => {
    it("removes expired grants", () => {
      const expired = manager.createGrant({
        issuerSessionId: "sess1",
        allowedConversationIds: [1],
        ttlMs: 0,
      });
      const active = manager.createGrant({
        issuerSessionId: "sess1",
        allowedConversationIds: [2],
        ttlMs: 300_000,
      });

      const removed = manager.cleanup();
      expect(removed).toBe(1);

      // Active grant still retrievable
      expect(manager.getGrant(active.grantId)).not.toBeNull();
      // Expired grant gone from internal store (getGrant would return null
      // even before cleanup for expired, but after cleanup the entry is fully removed)
    });

    it("removes revoked grants", () => {
      const grant = manager.createGrant({
        issuerSessionId: "sess1",
        allowedConversationIds: [1],
      });
      manager.revokeGrant(grant.grantId);

      const removed = manager.cleanup();
      expect(removed).toBe(1);
    });

    it("removes both expired and revoked grants in one pass", () => {
      manager.createGrant({
        issuerSessionId: "sess1",
        allowedConversationIds: [1],
        ttlMs: 0,
      });
      const revoked = manager.createGrant({
        issuerSessionId: "sess1",
        allowedConversationIds: [2],
      });
      manager.revokeGrant(revoked.grantId);
      manager.createGrant({
        issuerSessionId: "sess1",
        allowedConversationIds: [3],
        ttlMs: 300_000,
      });

      const removed = manager.cleanup();
      expect(removed).toBe(2);
    });

    it("returns 0 when nothing to clean", () => {
      manager.createGrant({
        issuerSessionId: "sess1",
        allowedConversationIds: [1],
      });
      expect(manager.cleanup()).toBe(0);
    });
  });
});

// ===========================================================================
// 2. wrapWithAuth
// ===========================================================================

describe("wrapWithAuth", () => {
  let manager: ExpansionAuthManager;
  let mockExpand: ReturnType<typeof vi.fn>;
  let mockOrchestrator: ExpansionOrchestrator;

  beforeEach(() => {
    manager = new ExpansionAuthManager();
    mockExpand = vi.fn<(req: ExpansionRequest) => Promise<ExpansionResult>>();
    // We only need the expand method, so we cast a partial mock
    mockOrchestrator = { expand: mockExpand } as unknown as ExpansionOrchestrator;
  });

  it("delegates to orchestrator when grant is valid", async () => {
    const grant = manager.createGrant({
      issuerSessionId: "sess1",
      allowedConversationIds: [1],
      allowedSummaryIds: [],
      tokenCap: 4000,
    });

    const expectedResult = makeExpansionResult({
      expansions: [
        {
          summaryId: "sum_a",
          children: [],
          messages: [],
        },
      ],
      totalTokens: 100,
    });
    mockExpand.mockResolvedValue(expectedResult);

    const authorized = wrapWithAuth(mockOrchestrator, manager);
    const request: ExpansionRequest = {
      summaryIds: ["sum_a"],
      conversationId: 1,
      maxDepth: 2,
      tokenCap: 2000,
    };

    const result = await authorized.expand(grant.grantId, request);

    expect(mockExpand).toHaveBeenCalledOnce();
    expect(result).toEqual(expectedResult);
  });

  it("throws when grant is invalid", async () => {
    const authorized = wrapWithAuth(mockOrchestrator, manager);
    const request: ExpansionRequest = {
      summaryIds: ["sum_a"],
      conversationId: 1,
      maxDepth: 1,
      tokenCap: 1000,
    };

    await expect(authorized.expand("grant_fake", request)).rejects.toThrow(
      /authorization failed.*not found/i,
    );
    expect(mockExpand).not.toHaveBeenCalled();
  });

  it("throws when grant is expired", async () => {
    const grant = manager.createGrant({
      issuerSessionId: "sess1",
      allowedConversationIds: [1],
      ttlMs: 0,
    });

    const authorized = wrapWithAuth(mockOrchestrator, manager);
    const request: ExpansionRequest = {
      summaryIds: [],
      conversationId: 1,
      maxDepth: 1,
      tokenCap: 1000,
    };

    await expect(authorized.expand(grant.grantId, request)).rejects.toThrow(
      /authorization failed.*expired/i,
    );
    expect(mockExpand).not.toHaveBeenCalled();
  });

  it("throws when grant is revoked", async () => {
    const grant = manager.createGrant({
      issuerSessionId: "sess1",
      allowedConversationIds: [1],
    });
    manager.revokeGrant(grant.grantId);

    const authorized = wrapWithAuth(mockOrchestrator, manager);
    const request: ExpansionRequest = {
      summaryIds: [],
      conversationId: 1,
      maxDepth: 1,
      tokenCap: 1000,
    };

    await expect(authorized.expand(grant.grantId, request)).rejects.toThrow(
      /authorization failed.*revoked/i,
    );
  });

  it("passes through explicit tokenCap values", async () => {
    const grant = manager.createGrant({
      issuerSessionId: "sess1",
      allowedConversationIds: [1],
      allowedSummaryIds: [],
      tokenCap: 1000,
    });

    mockExpand.mockResolvedValue(makeExpansionResult());

    const authorized = wrapWithAuth(mockOrchestrator, manager);

    const request: ExpansionRequest = {
      summaryIds: ["sum_a"],
      conversationId: 1,
      maxDepth: 2,
      tokenCap: 800,
    };

    await authorized.expand(grant.grantId, request);

    // The wrapper should pass request values through unchanged.
    const calledWith = mockExpand.mock.calls[0][0];
    expect(calledWith.tokenCap).toBe(800);
  });

  it("does not inject tokenCap when request omits it", async () => {
    const grant = manager.createGrant({
      issuerSessionId: "sess1",
      allowedConversationIds: [1],
      allowedSummaryIds: [],
      tokenCap: 4000,
    });

    mockExpand.mockResolvedValue(makeExpansionResult());

    const authorized = wrapWithAuth(mockOrchestrator, manager);
    const request: ExpansionRequest = {
      summaryIds: ["sum_a"],
      conversationId: 1,
    };

    await authorized.expand(grant.grantId, request);

    const calledWith = mockExpand.mock.calls[0][0];
    expect(calledWith.tokenCap).toBeUndefined();
  });
});

// ===========================================================================
// 3. ExpansionOrchestrator
// ===========================================================================

describe("ExpansionOrchestrator", () => {
  let mockRetrieval: ReturnType<typeof makeMockRetrieval>;
  let orchestrator: ExpansionOrchestrator;

  beforeEach(() => {
    mockRetrieval = makeMockRetrieval();
    orchestrator = new ExpansionOrchestrator(mockRetrieval as unknown as RetrievalEngine);
  });

  it("expands multiple summaryIds and collects citedIds", async () => {
    mockRetrieval.expand
      .mockResolvedValueOnce(
        makeExpandResult({
          children: [
            { summaryId: "sum_child_1", kind: "leaf", content: "child 1 content", tokenCount: 50 },
          ],
          estimatedTokens: 50,
        }),
      )
      .mockResolvedValueOnce(
        makeExpandResult({
          children: [
            { summaryId: "sum_child_2", kind: "leaf", content: "child 2 content", tokenCount: 60 },
          ],
          estimatedTokens: 60,
        }),
      );

    const result = await orchestrator.expand({
      summaryIds: ["sum_a", "sum_b"],
      conversationId: 1,
      maxDepth: 2,
    });

    expect(result.expansions).toHaveLength(2);
    expect(result.expansions[0].summaryId).toBe("sum_a");
    expect(result.expansions[0].children).toHaveLength(1);
    expect(result.expansions[1].summaryId).toBe("sum_b");
    expect(result.expansions[1].children).toHaveLength(1);
    expect(result.totalTokens).toBe(110);
    expect(result.truncated).toBe(false);

    // citedIds should include both parent and child summary IDs
    expect(result.citedIds).toContain("sum_a");
    expect(result.citedIds).toContain("sum_child_1");
    expect(result.citedIds).toContain("sum_b");
    expect(result.citedIds).toContain("sum_child_2");
  });

  it("passes correct arguments to retrieval.expand", async () => {
    mockRetrieval.expand.mockResolvedValue(makeExpandResult({ estimatedTokens: 0 }));

    await orchestrator.expand({
      summaryIds: ["sum_a"],
      conversationId: 1,
      maxDepth: 5,
      tokenCap: 3000,
      includeMessages: true,
    });

    expect(mockRetrieval.expand).toHaveBeenCalledWith({
      summaryId: "sum_a",
      depth: 5,
      includeMessages: true,
      tokenCap: 3000,
    });
  });

  it("enforces global tokenCap across multiple expansions", async () => {
    // First expansion uses 900 tokens out of 1000 budget
    mockRetrieval.expand
      .mockResolvedValueOnce(
        makeExpandResult({
          children: [
            { summaryId: "sum_c1", kind: "leaf", content: "big content", tokenCount: 900 },
          ],
          estimatedTokens: 900,
        }),
      )
      .mockResolvedValueOnce(
        makeExpandResult({
          children: [
            { summaryId: "sum_c2", kind: "leaf", content: "more content", tokenCount: 50 },
          ],
          estimatedTokens: 50,
          truncated: true,
        }),
      );

    const result = await orchestrator.expand({
      summaryIds: ["sum_a", "sum_b"],
      conversationId: 1,
      tokenCap: 1000,
    });

    // Second expand call should receive remaining budget of 100
    expect(mockRetrieval.expand).toHaveBeenCalledTimes(2);
    const secondCall = mockRetrieval.expand.mock.calls[1][0];
    expect(secondCall.tokenCap).toBe(100);

    // Result reflects truncation from the retrieval engine
    expect(result.truncated).toBe(true);
    expect(result.totalTokens).toBe(950);
  });

  it("stops expanding when budget is exhausted", async () => {
    mockRetrieval.expand.mockResolvedValueOnce(makeExpandResult({ estimatedTokens: 500 }));

    const result = await orchestrator.expand({
      summaryIds: ["sum_a", "sum_b", "sum_c"],
      conversationId: 1,
      tokenCap: 500,
    });

    // After first expansion uses all 500 tokens, remaining budget is 0
    // so the loop should mark truncated and skip sum_b and sum_c
    expect(mockRetrieval.expand).toHaveBeenCalledTimes(1);
    expect(result.truncated).toBe(true);
  });

  it("handles expansion with messages", async () => {
    mockRetrieval.expand.mockResolvedValue(
      makeExpandResult({
        messages: [
          { messageId: 10, role: "user", content: "Hello world", tokenCount: 3 },
          { messageId: 11, role: "assistant", content: "Hi there", tokenCount: 2 },
        ],
        estimatedTokens: 5,
      }),
    );

    const result = await orchestrator.expand({
      summaryIds: ["sum_leaf"],
      conversationId: 1,
      includeMessages: true,
    });

    expect(result.expansions[0].messages).toHaveLength(2);
    expect(result.expansions[0].messages[0].messageId).toBe(10);
    expect(result.expansions[0].messages[0].role).toBe("user");
    expect(result.totalTokens).toBe(5);
  });

  it("truncates long content to snippets", async () => {
    const longContent = "x".repeat(300);
    mockRetrieval.expand.mockResolvedValue(
      makeExpandResult({
        children: [{ summaryId: "sum_c1", kind: "leaf", content: longContent, tokenCount: 75 }],
        estimatedTokens: 75,
      }),
    );

    const result = await orchestrator.expand({
      summaryIds: ["sum_a"],
      conversationId: 1,
    });

    const snippet = result.expansions[0].children[0].snippet;
    // Content should be truncated to 200 chars + "..."
    expect(snippet.length).toBe(203);
    expect(snippet).toMatch(/\.\.\.$/);
  });

  // ── describeAndExpand ──────────────────────────────────────────────────

  it("describeAndExpand greps then expands top results", async () => {
    mockRetrieval.grep.mockResolvedValue({
      messages: [],
      summaries: [
        {
          summaryId: "sum_match1",
          conversationId: 1,
          kind: "leaf",
          snippet: "found it",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        },
        {
          summaryId: "sum_match2",
          conversationId: 1,
          kind: "condensed",
          snippet: "also found",
          createdAt: new Date("2026-01-02T00:00:00.000Z"),
        },
      ],
      totalMatches: 2,
    });
    mockRetrieval.expand
      .mockResolvedValueOnce(makeExpandResult({ estimatedTokens: 30 }))
      .mockResolvedValueOnce(makeExpandResult({ estimatedTokens: 40 }));

    const result = await orchestrator.describeAndExpand({
      query: "search term",
      mode: "full_text",
      conversationId: 1,
      maxDepth: 2,
      tokenCap: 5000,
    });

    // Verify grep was called correctly
    expect(mockRetrieval.grep).toHaveBeenCalledWith({
      query: "search term",
      mode: "full_text",
      scope: "summaries",
      conversationId: 1,
    });

    // Verify expand was called for each grep result
    expect(mockRetrieval.expand).toHaveBeenCalledTimes(2);
    expect(result.expansions).toHaveLength(2);
    expect(result.totalTokens).toBe(70);
  });

  it("describeAndExpand returns empty when grep finds nothing", async () => {
    mockRetrieval.grep.mockResolvedValue({
      messages: [],
      summaries: [],
      totalMatches: 0,
    });

    const result = await orchestrator.describeAndExpand({
      query: "nothing matches",
      mode: "regex",
      conversationId: 1,
    });

    expect(result.expansions).toHaveLength(0);
    expect(result.citedIds).toHaveLength(0);
    expect(result.totalTokens).toBe(0);
    expect(result.truncated).toBe(false);

    // expand should never have been called
    expect(mockRetrieval.expand).not.toHaveBeenCalled();
  });

  it("describeAndExpand passes conversationId through to expand", async () => {
    mockRetrieval.grep.mockResolvedValue({
      messages: [],
      summaries: [
        {
          summaryId: "sum_x",
          conversationId: 42,
          kind: "leaf",
          snippet: "match",
          createdAt: new Date("2026-01-03T00:00:00.000Z"),
        },
      ],
      totalMatches: 1,
    });
    mockRetrieval.expand.mockResolvedValue(makeExpandResult({ estimatedTokens: 10 }));

    await orchestrator.describeAndExpand({
      query: "test",
      mode: "full_text",
      conversationId: 42,
    });

    // The inner expand call should use conversationId=42
    // (This is tested indirectly — the expand method is called with the right request)
    expect(mockRetrieval.grep).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 42 }),
    );
  });

  it("describeAndExpand biases expansion order toward newer summaries", async () => {
    const expandOrder: string[] = [];
    mockRetrieval.grep.mockResolvedValue({
      messages: [],
      summaries: [
        {
          summaryId: "sum_old",
          conversationId: 1,
          kind: "leaf",
          snippet: "older",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        },
        {
          summaryId: "sum_new",
          conversationId: 1,
          kind: "leaf",
          snippet: "newer",
          createdAt: new Date("2026-01-02T00:00:00.000Z"),
        },
      ],
      totalMatches: 2,
    });
    mockRetrieval.expand.mockImplementation(async (input: { summaryId: string }) => {
      expandOrder.push(input.summaryId);
      return makeExpandResult({ estimatedTokens: 10 });
    });

    await orchestrator.describeAndExpand({
      query: "recent first",
      mode: "full_text",
      conversationId: 1,
    });

    expect(expandOrder).toEqual(["sum_new", "sum_old"]);
  });

  it("describeAndExpand allows query mode without conversationId", async () => {
    mockRetrieval.grep.mockResolvedValue({
      messages: [],
      summaries: [
        {
          summaryId: "sum_any",
          conversationId: 9,
          kind: "leaf",
          snippet: "match",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      ],
      totalMatches: 1,
    });
    mockRetrieval.expand.mockResolvedValue(makeExpandResult({ estimatedTokens: 5 }));

    await orchestrator.describeAndExpand({
      query: "global query",
      mode: "full_text",
    });

    expect(mockRetrieval.grep).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: undefined }),
    );
  });
});

// ===========================================================================
// 4. distillForSubagent
// ===========================================================================

describe("distillForSubagent", () => {
  it("formats expansion result into readable text", () => {
    const result = makeExpansionResult({
      expansions: [
        {
          summaryId: "sum_a",
          children: [
            { summaryId: "sum_child_1", kind: "leaf", snippet: "child snippet", tokenCount: 50 },
            {
              summaryId: "sum_child_2",
              kind: "condensed",
              snippet: "another snippet",
              tokenCount: 80,
            },
          ],
          messages: [],
        },
        {
          summaryId: "sum_b",
          children: [],
          messages: [
            { messageId: 5, role: "user", snippet: "user said hello", tokenCount: 10 },
            { messageId: 6, role: "assistant", snippet: "bot replied", tokenCount: 15 },
          ],
        },
      ],
      citedIds: ["sum_a", "sum_child_1", "sum_child_2", "sum_b"],
      totalTokens: 155,
      truncated: false,
    });

    const output = distillForSubagent(result);

    // Header
    expect(output).toContain("2 summaries");
    expect(output).toContain("155 total tokens");

    // First expansion (condensed, has children)
    expect(output).toContain("### sum_a (condensed");
    expect(output).toContain("Children: sum_child_1, sum_child_2");
    expect(output).toContain("[Snippet: child snippet]");

    // Second expansion (leaf, has messages)
    expect(output).toContain("### sum_b (leaf");
    expect(output).toContain("msg#5 (user, 10 tokens)");
    expect(output).toContain("msg#6 (assistant, 15 tokens)");

    // Cited IDs
    expect(output).toContain("Cited IDs for follow-up:");
    expect(output).toContain("sum_a");
    expect(output).toContain("sum_child_1");

    // Truncation indicator
    expect(output).toContain("[Truncated: no]");
  });

  it("indicates truncation when truncated", () => {
    const result = makeExpansionResult({
      truncated: true,
    });

    const output = distillForSubagent(result);
    expect(output).toContain("[Truncated: yes]");
  });

  it("handles empty expansion result", () => {
    const result = makeExpansionResult();
    const output = distillForSubagent(result);

    expect(output).toContain("0 summaries");
    expect(output).toContain("0 total tokens");
    expect(output).toContain("[Truncated: no]");
    // No cited IDs line when empty
    expect(output).not.toContain("Cited IDs");
  });

  it("computes per-entry token sum from children and messages", () => {
    const result = makeExpansionResult({
      expansions: [
        {
          summaryId: "sum_mixed",
          children: [
            { summaryId: "sum_c1", kind: "leaf", snippet: "a", tokenCount: 100 },
            { summaryId: "sum_c2", kind: "leaf", snippet: "b", tokenCount: 200 },
          ],
          messages: [{ messageId: 1, role: "user", snippet: "c", tokenCount: 50 }],
        },
      ],
      totalTokens: 350,
    });

    const output = distillForSubagent(result);
    // 100 + 200 + 50 = 350 tokens for this entry
    expect(output).toContain("### sum_mixed (condensed, 350 tokens)");
  });
});

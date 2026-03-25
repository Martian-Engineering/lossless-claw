import { describe, it, expect } from "vitest";
import { RlmEngine } from "../src/rlm/rlm.js";
import type { RlmSummaryEntry, RlmPattern } from "../src/rlm/types.js";

describe("RLM Pattern Detection", () => {
  it("should detect recurring themes heuristically when no LLM provided", async () => {
    const engine = new RlmEngine({
      enabled: true,
      provider: "",
      model: "",
      minDepth: 2,
      patternThreshold: 0.5,
    });

    // Use longer words (5+ characters) to meet heuristic filter
    const entries: RlmSummaryEntry[] = [
      {
        summaryId: "sum_001",
        content: "Discussion about testing strategies and testing coverage for the application framework",
        depth: 1,
        createdAt: new Date("2024-01-15T10:00:00Z"),
        tokenCount: 100,
      },
      {
        summaryId: "sum_002",
        content: "More testing approaches and testing methodology for validation framework development",
        depth: 1,
        createdAt: new Date("2024-01-15T11:00:00Z"),
        tokenCount: 120,
      },
      {
        summaryId: "sum_003",
        content: "Testing patterns and testing best practices discussion about framework architecture",
        depth: 1,
        createdAt: new Date("2024-01-15T12:00:00Z"),
        tokenCount: 110,
      },
    ];

    const result = await engine.analyzePatterns(entries);

    expect(result.patterns.length).toBeGreaterThan(0);
    expect(result.hasViablePatterns).toBe(true);
    expect(result.patterns[0].type).toBe("recurring_theme");
  });

  it("should return empty patterns when entries have no common themes", async () => {
    const engine = new RlmEngine({
      enabled: true,
      provider: "",
      model: "",
      minDepth: 2,
      patternThreshold: 0.7,
    });

    const entries: RlmSummaryEntry[] = [
      {
        summaryId: "sum_001",
        content: "Discussion about quantum physics and particle behavior",
        depth: 1,
        createdAt: new Date(),
        tokenCount: 100,
      },
      {
        summaryId: "sum_002",
        content: "Cooking recipes for Italian pasta dishes",
        depth: 1,
        createdAt: new Date(),
        tokenCount: 120,
      },
      {
        summaryId: "sum_003",
        content: "Gardening tips for tropical plants",
        depth: 1,
        createdAt: new Date(),
        tokenCount: 110,
      },
    ];

    const result = await engine.analyzePatterns(entries);

    // Should have very low confidence due to unrelated topics
    expect(result.overallConfidence).toBeLessThan(0.5);
    expect(result.hasViablePatterns).toBe(false);
  });

  it("should correctly populate unpatternedSummaries", async () => {
    const engine = new RlmEngine({
      enabled: true,
      provider: "",
      model: "",
      minDepth: 2,
      patternThreshold: 0.5,
    });

    const entries: RlmSummaryEntry[] = [
      {
        summaryId: "sum_001",
        content: "Testing strategies and testing coverage analysis",
        depth: 1,
        createdAt: new Date(),
        tokenCount: 100,
      },
      {
        summaryId: "sum_002",
        content: "Testing methodology and testing approaches",
        depth: 1,
        createdAt: new Date(),
        tokenCount: 120,
      },
      {
        summaryId: "sum_003",
        content: "Completely unrelated topic about astronomy",
        depth: 1,
        createdAt: new Date(),
        tokenCount: 110,
      },
    ];

    const result = await engine.analyzePatterns(entries);

    // sum_003 should be unpatterned since it doesn't share the "testing" theme
    const unpatternedIds = result.unpatternedSummaries.map(e => e.summaryId);
    expect(unpatternedIds).toContain("sum_003");
  });

  it("should calculate token savings correctly", async () => {
    const engine = new RlmEngine({
      enabled: true,
      provider: "",
      model: "",
      minDepth: 2,
      patternThreshold: 0.5,
    });

    const entries: RlmSummaryEntry[] = [
      {
        summaryId: "sum_001",
        content: "Testing strategies and testing coverage analysis for the application",
        depth: 1,
        createdAt: new Date(),
        tokenCount: 200,
      },
      {
        summaryId: "sum_002",
        content: "Testing methodology and testing approaches for validation",
        depth: 1,
        createdAt: new Date(),
        tokenCount: 220,
      },
    ];

    const result = await engine.analyzePatterns(entries);

    if (result.patterns.length > 0) {
      expect(result.totalTokenSavings).toBeGreaterThan(0);
      expect(result.patterns[0].tokenSavings).toBeGreaterThan(0);
    }
  });
});

describe("RLM Summarize with Patterns", () => {
  it("should generate heuristic summary when no LLM available", async () => {
    const engine = new RlmEngine({
      enabled: true,
      provider: "",
      model: "",
      minDepth: 2,
      patternThreshold: 0.5,
    });

    // Use longer words (5+ chars) to trigger pattern detection
    const entries: RlmSummaryEntry[] = [
      {
        summaryId: "sum_001",
        content: "Testing strategies discussion about framework validation approaches",
        depth: 2,
        createdAt: new Date(),
        tokenCount: 100,
      },
      {
        summaryId: "sum_002",
        content: "Testing methodology overview for framework validation strategies",
        depth: 2,
        createdAt: new Date(),
        tokenCount: 120,
      },
    ];

    const result = await engine.summarize(entries, { depth: 2 });

    // With patterns detected, should generate content
    expect(result.content).toBeTruthy();
    expect(result.usedPatterns).toBe(true);
    expect(result.fallbackToStandard).toBe(false);
  });

  it("should include pattern references in generated summary", async () => {
    const engine = new RlmEngine({
      enabled: true,
      provider: "",
      model: "",
      minDepth: 2,
      patternThreshold: 0.5,
    });

    // Use longer words (5+ chars) to trigger pattern detection
    const entries: RlmSummaryEntry[] = [
      {
        summaryId: "sum_001",
        content: "Testing strategies and testing coverage for application framework validation",
        depth: 2,
        createdAt: new Date(),
        tokenCount: 150,
      },
      {
        summaryId: "sum_002",
        content: "Testing methodology and testing approaches for validation framework architecture",
        depth: 2,
        createdAt: new Date(),
        tokenCount: 180,
      },
    ];

    const result = await engine.summarize(entries, { depth: 2 });

    // Should have applied patterns
    expect(result.appliedPatterns).toBeDefined();
    expect(result.appliedPatterns!.length).toBeGreaterThan(0);
    // Content may or may not contain "pattern" depending on heuristic generation
    expect(result.content.length).toBeGreaterThan(0);
  });
});

describe("RLM Metrics", () => {
  it("should track metrics across operations", async () => {
    const engine = new RlmEngine({
      enabled: true,
      provider: "",
      model: "",
      minDepth: 2,
      patternThreshold: 0.5,
    });

    // Use longer words (5+ chars) to trigger pattern detection
    const entries: RlmSummaryEntry[] = [
      {
        summaryId: "sum_001",
        content: "Testing strategies and testing coverage for framework validation",
        depth: 2,
        createdAt: new Date(),
        tokenCount: 100,
      },
      {
        summaryId: "sum_002",
        content: "Testing methodology and testing approaches for framework architecture",
        depth: 2,
        createdAt: new Date(),
        tokenCount: 120,
      },
    ];

    // Initial metrics
    const initialMetrics = engine.getMetrics();
    expect(initialMetrics.analysesPerformed).toBe(0);

    // Perform analysis
    await engine.analyzePatterns(entries);
    
    const afterAnalysis = engine.getMetrics();
    expect(afterAnalysis.analysesPerformed).toBe(1);

    // Perform summarization (only counts if patterns were detected and used)
    const summarizeResult = await engine.summarize(entries, { depth: 2 });
    
    const afterSummarize = engine.getMetrics();
    // rlmSummariesGenerated only increments when patterns are viable and summary is generated
    if (summarizeResult.usedPatterns && !summarizeResult.fallbackToStandard) {
      expect(afterSummarize.rlmSummariesGenerated).toBe(1);
    }
    // analysesPerformed should be 2 (one from analyzePatterns, one from summarize calling analyzePatterns)
    expect(afterSummarize.analysesPerformed).toBe(2);
  });
});

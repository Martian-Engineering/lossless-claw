import { describe, expect, it } from "vitest";
import {
  EXPANSION_ROUTING_THRESHOLDS,
  classifyExpansionTokenRisk,
  decideLcmExpansionRouting,
  detectBroadTimeRangeIndicator,
  detectMultiHopIndicator,
  estimateExpansionTokens,
} from "./expansion-policy.js";

describe("decideLcmExpansionRouting", () => {
  it("applies the expected route-vs-delegate decision matrix", () => {
    const cases: Array<{
      name: string;
      input: Parameters<typeof decideLcmExpansionRouting>[0];
      expectedAction: ReturnType<typeof decideLcmExpansionRouting>["action"];
      expectedTrigger: keyof ReturnType<typeof decideLcmExpansionRouting>["triggers"];
      expectedTriggerValue: boolean;
    }> = [
      {
        name: "query probe with zero candidates",
        input: {
          intent: "query_probe",
          query: "recent auth failures",
          candidateSummaryCount: 0,
          requestedMaxDepth: 3,
          tokenCap: 1200,
        },
        expectedAction: "answer_directly",
        expectedTrigger: "directByNoCandidates",
        expectedTriggerValue: true,
      },
      {
        name: "query probe at low-complexity bounds",
        input: {
          intent: "query_probe",
          query: "failed login",
          candidateSummaryCount: 1,
          requestedMaxDepth: 2,
          tokenCap: 10_000,
        },
        expectedAction: "answer_directly",
        expectedTrigger: "directByLowComplexityProbe",
        expectedTriggerValue: true,
      },
      {
        name: "explicit expand under delegation thresholds",
        input: {
          intent: "explicit_expand",
          candidateSummaryCount: 2,
          requestedMaxDepth: 2,
          tokenCap: 10_000,
        },
        expectedAction: "expand_shallow",
        expectedTrigger: "delegateByDepth",
        expectedTriggerValue: false,
      },
      {
        name: "query probe with deep depth does not auto-delegate",
        input: {
          intent: "query_probe",
          query: "auth chain",
          candidateSummaryCount: 2,
          requestedMaxDepth: 4,
          tokenCap: 10_000,
        },
        expectedAction: "expand_shallow",
        expectedTrigger: "delegateByDepth",
        expectedTriggerValue: false,
      },
      {
        name: "query probe with many candidates does not auto-delegate",
        input: {
          intent: "query_probe",
          query: "incident spread",
          candidateSummaryCount: 6,
          requestedMaxDepth: 2,
          tokenCap: 10_000,
        },
        expectedAction: "expand_shallow",
        expectedTrigger: "delegateByCandidateCount",
        expectedTriggerValue: false,
      },
      {
        name: "query probe with broad range and multi-hop indicators",
        input: {
          intent: "query_probe",
          query: "build timeline from 2021 to 2025 and explain root cause chain",
          candidateSummaryCount: 2,
          requestedMaxDepth: 2,
          tokenCap: 10_000,
        },
        expectedAction: "delegate_traversal",
        expectedTrigger: "delegateByBroadTimeRangeAndMultiHop",
        expectedTriggerValue: true,
      },
    ];

    for (const scenario of cases) {
      const decision = decideLcmExpansionRouting(scenario.input);
      expect(decision.action, scenario.name).toBe(scenario.expectedAction);
      expect(decision.triggers[scenario.expectedTrigger], scenario.name).toBe(
        scenario.expectedTriggerValue,
      );
    }
  });

  it("answers directly when no candidate summaries are available", () => {
    const decision = decideLcmExpansionRouting({
      intent: "query_probe",
      query: "recent auth failures",
      candidateSummaryCount: 0,
      requestedMaxDepth: 3,
      tokenCap: 1200,
    });

    expect(decision.action).toBe("answer_directly");
    expect(decision.triggers.directByNoCandidates).toBe(true);
  });

  it("answers directly for low-complexity query probes", () => {
    const decision = decideLcmExpansionRouting({
      intent: "query_probe",
      query: "failed login",
      candidateSummaryCount: 1,
      requestedMaxDepth: 2,
      tokenCap: 10_000,
    });

    expect(decision.action).toBe("answer_directly");
    expect(decision.triggers.directByLowComplexityProbe).toBe(true);
  });

  it("uses shallow expansion for low-complexity explicit expand requests", () => {
    const decision = decideLcmExpansionRouting({
      intent: "explicit_expand",
      candidateSummaryCount: 1,
      requestedMaxDepth: 2,
      tokenCap: 10_000,
    });

    expect(decision.action).toBe("expand_shallow");
  });

  it("does not delegate solely due to depth", () => {
    const below = decideLcmExpansionRouting({
      intent: "query_probe",
      query: "auth chain",
      candidateSummaryCount: 2,
      requestedMaxDepth: 3,
      tokenCap: 10_000,
    });
    const at = decideLcmExpansionRouting({
      intent: "query_probe",
      query: "auth chain",
      candidateSummaryCount: 2,
      requestedMaxDepth: 4,
      tokenCap: 10_000,
    });

    expect(below.action).toBe("expand_shallow");
    expect(at.action).toBe("expand_shallow");
    expect(at.triggers.delegateByDepth).toBe(false);
  });

  it("does not delegate solely due to candidate-count", () => {
    const below = decideLcmExpansionRouting({
      intent: "query_probe",
      query: "incident spread",
      candidateSummaryCount: 5,
      requestedMaxDepth: 2,
      tokenCap: 10_000,
    });
    const at = decideLcmExpansionRouting({
      intent: "query_probe",
      query: "incident spread",
      candidateSummaryCount: 6,
      requestedMaxDepth: 2,
      tokenCap: 10_000,
    });

    expect(below.action).toBe("expand_shallow");
    expect(at.action).toBe("expand_shallow");
    expect(at.triggers.delegateByCandidateCount).toBe(false);
  });

  it("delegates when token risk crosses the high-risk boundary", () => {
    const estimateInput = {
      requestedMaxDepth: 3,
      candidateSummaryCount: 3,
      includeMessages: true,
      broadTimeRangeIndicator: false,
      multiHopIndicator: true,
    };
    const estimatedTokens = estimateExpansionTokens(estimateInput);
    const capJustBelowHighRisk = Math.max(
      1,
      Math.ceil(estimatedTokens / EXPANSION_ROUTING_THRESHOLDS.highTokenRiskRatio) - 1,
    );
    const capAtOrAboveHighRisk = Math.ceil(
      estimatedTokens / EXPANSION_ROUTING_THRESHOLDS.highTokenRiskRatio,
    );

    const below = decideLcmExpansionRouting({
      intent: "query_probe",
      query: "root cause chain",
      candidateSummaryCount: estimateInput.candidateSummaryCount,
      requestedMaxDepth: estimateInput.requestedMaxDepth,
      includeMessages: true,
      tokenCap: capAtOrAboveHighRisk,
    });
    const at = decideLcmExpansionRouting({
      intent: "query_probe",
      query: "root cause chain",
      candidateSummaryCount: estimateInput.candidateSummaryCount,
      requestedMaxDepth: estimateInput.requestedMaxDepth,
      includeMessages: true,
      tokenCap: capJustBelowHighRisk,
    });

    expect(below.action).toBe("expand_shallow");
    expect(at.action).toBe("delegate_traversal");
    expect(at.triggers.delegateByTokenRisk).toBe(true);
  });

  it("delegates for combined broad time-range and multi-hop indicators", () => {
    const decision = decideLcmExpansionRouting({
      intent: "query_probe",
      query: "build timeline from 2021 to 2025 and explain root cause chain",
      candidateSummaryCount: 2,
      requestedMaxDepth: 2,
      tokenCap: 10_000,
    });

    expect(decision.action).toBe("delegate_traversal");
    expect(decision.triggers.delegateByBroadTimeRangeAndMultiHop).toBe(true);
  });
});

describe("expansion-policy indicators", () => {
  it("detects broad time-range year windows of at least two years", () => {
    expect(detectBroadTimeRangeIndicator("events from 2022 to 2024")).toBe(true);
    expect(detectBroadTimeRangeIndicator("events from 2024 to 2025")).toBe(false);
  });

  it("detects multi-hop from traversal depth and query language", () => {
    expect(
      detectMultiHopIndicator({
        query: "normal summary lookup",
        requestedMaxDepth: EXPANSION_ROUTING_THRESHOLDS.multiHopDepthThreshold,
        candidateSummaryCount: 1,
      }),
    ).toBe(true);
    expect(
      detectMultiHopIndicator({
        query: "explain the chain of events",
        requestedMaxDepth: 1,
        candidateSummaryCount: 1,
      }),
    ).toBe(true);
  });

  it("classifies token risk at exact ratio boundaries", () => {
    const moderate = classifyExpansionTokenRisk({
      estimatedTokens: 35,
      tokenCap: 100,
    });
    const high = classifyExpansionTokenRisk({
      estimatedTokens: 70,
      tokenCap: 100,
    });

    expect(moderate.level).toBe("moderate");
    expect(high.level).toBe("high");
    expect(moderate.ratio).toBeCloseTo(EXPANSION_ROUTING_THRESHOLDS.moderateTokenRiskRatio, 8);
    expect(high.ratio).toBeCloseTo(EXPANSION_ROUTING_THRESHOLDS.highTokenRiskRatio, 8);
  });
});

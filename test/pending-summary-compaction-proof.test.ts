import { describe, expect, it } from "vitest";
import { runPendingSummaryCompactionProof } from "../scripts/e2e/pending-summary-compaction-proof.js";

describe("pending summary compaction proof harness", () => {
  it("demonstrates hidden preparation and atomic publish", async () => {
    const report = await runPendingSummaryCompactionProof();

    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.checkpoints.map((checkpoint) => checkpoint.label)).toEqual([
      "seeded-raw-context",
      "after-plan",
      "after-leaf-preparation",
      "after-condensed-preparation",
      "after-ready-no-publish",
      "after-tail-growth-extension-plan",
      "after-extension-leaf-preparation",
      "after-extension-condensed-preparation",
      "after-extension-ready-no-publish",
      "after-publish",
    ]);
    expect(
      report.checkpoints
        .filter((checkpoint) => checkpoint.label !== "after-publish")
        .every((checkpoint) => checkpoint.canonicalSummaries === 0),
    ).toBe(true);
    expect(
      report.checkpoints
        .filter((checkpoint) => checkpoint.label !== "after-publish")
        .every((checkpoint) =>
          checkpoint.contextItems.every((item) => item.itemType === "message"),
        ),
    ).toBe(true);

    const afterCondensed = report.checkpoints.find(
      (checkpoint) => checkpoint.label === "after-condensed-preparation",
    );
    expect(afterCondensed?.summarizeCalls.some((call) => call.isCondensed)).toBe(true);
    expect(
      afterCondensed?.summarizeCalls.find((call) => call.isCondensed)?.sourceText,
    ).toContain("proof leaf summary over:");

    const afterReady = report.checkpoints.find(
      (checkpoint) => checkpoint.label === "after-ready-no-publish",
    );
    expect(afterReady?.canonicalSummaries).toBe(0);
    expect(afterReady?.contextItems.every((item) => item.itemType === "message")).toBe(true);
    expect(afterReady?.pendingNodes.every((node) => node.status === "ready")).toBe(true);

    const afterExtensionPlan = report.checkpoints.find(
      (checkpoint) => checkpoint.label === "after-tail-growth-extension-plan",
    );
    expect(afterExtensionPlan?.canonicalSummaries).toBe(0);
    expect(afterExtensionPlan?.pendingNodes).toHaveLength(5);
    expect(
      afterExtensionPlan?.pendingNodes.filter((node) => node.status === "ready"),
    ).toHaveLength(3);
    expect(
      afterExtensionPlan?.pendingNodes.some(
        (node) => node.kind === "condensed" && node.ordinalStart === 0 && node.ordinalEnd === 3,
      ),
    ).toBe(true);

    const afterExtensionReady = report.checkpoints.find(
      (checkpoint) => checkpoint.label === "after-extension-ready-no-publish",
    );
    expect(afterExtensionReady?.canonicalSummaries).toBe(0);
    expect(afterExtensionReady?.contextItems.every((item) => item.itemType === "message")).toBe(
      true,
    );
    expect(afterExtensionReady?.pendingNodes.every((node) => node.status === "ready")).toBe(true);
    expect(
      afterExtensionReady?.summarizeCalls.filter((call) => !call.isCondensed),
    ).toHaveLength(3);
    expect(
      afterExtensionReady?.summarizeCalls
        .filter((call) => call.isCondensed)
        .some((call) => call.sourceText.includes("delta raw fresh tail")),
    ).toBe(true);

    const afterPublish = report.checkpoints.find(
      (checkpoint) => checkpoint.label === "after-publish",
    );
    expect(afterPublish?.canonicalSummaries).toBe(4);
    expect(afterPublish?.contextItems).toMatchObject([
      { ordinal: 0, itemType: "summary" },
      { ordinal: 1, itemType: "message" },
    ]);
    expect(
      afterPublish?.pendingNodes.filter((node) => node.status === "promoted"),
    ).toHaveLength(4);
    expect(
      afterPublish?.pendingNodes.some(
        (node) =>
          node.status === "ready" &&
          node.kind === "condensed" &&
          node.ordinalStart === 0 &&
          node.ordinalEnd === 2,
      ),
    ).toBe(true);
    expect(report.publishedSummaryId).toMatch(/^sum_/);
  });
});

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

    const afterPublish = report.checkpoints.find(
      (checkpoint) => checkpoint.label === "after-publish",
    );
    expect(afterPublish?.canonicalSummaries).toBe(3);
    expect(afterPublish?.contextItems).toMatchObject([
      { ordinal: 0, itemType: "summary" },
      { ordinal: 1, itemType: "message" },
    ]);
    expect(afterPublish?.pendingNodes.every((node) => node.status === "promoted")).toBe(true);
    expect(report.publishedSummaryId).toMatch(/^sum_/);
  });
});

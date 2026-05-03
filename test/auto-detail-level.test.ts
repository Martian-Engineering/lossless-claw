import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { __lcmRecentTestInternals } from "../src/tools/lcm-recent-tool.js";

const { computeAutoDetailLevel } = __lcmRecentTestInternals;

/**
 * Unit tests for the Tier-1-only auto-detail-level picker. Builds a minimal
 * in-memory schema with just the columns we read so we don't depend on the
 * full migration suite. See audit/pr516/INVESTIGATION-design-calls.md and
 * audit/pr516/round2-C-design.md Item 1 for the design rationale (Tier 2/3
 * deletion).
 */
function makeTelemetryDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE conversation_compaction_telemetry (
      conversation_id INTEGER PRIMARY KEY,
      last_observed_prompt_token_count INTEGER,
      model TEXT
    );
  `);
  return db;
}

function insertTelemetry(
  db: DatabaseSync,
  conversationId: number,
  tokens: number | null,
  model: string | null,
): void {
  db.prepare(
    `INSERT INTO conversation_compaction_telemetry
       (conversation_id, last_observed_prompt_token_count, model)
       VALUES (?, ?, ?)`,
  ).run(conversationId, tokens, model);
}

describe("computeAutoDetailLevel (Tier-1-only)", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = makeTelemetryDb();
  });

  it("returns the matching tier when registry has the model and usage is low", () => {
    // 200k context, 0 tokens used → safety reserve = 40k → remaining = 160k → tier 3.
    insertTelemetry(db, 1, 0, "gpt-5.4");
    const level = computeAutoDetailLevel(db, 1, () => 200_000);
    expect(level).toBe(3);
  });

  it("returns null when the model is missing from the registry", () => {
    insertTelemetry(db, 1, 1_000, "unknown-model");
    const level = computeAutoDetailLevel(db, 1, () => null);
    expect(level).toBeNull();
  });

  it("returns null when no telemetry row exists for the conversation", () => {
    const level = computeAutoDetailLevel(db, 999, () => 200_000);
    expect(level).toBeNull();
  });

  it("returns null when telemetry has no model id", () => {
    insertTelemetry(db, 1, 1_000, null);
    const level = computeAutoDetailLevel(db, 1, () => 200_000);
    expect(level).toBeNull();
  });

  it("returns null when getModelContextWindow is undefined", () => {
    insertTelemetry(db, 1, 1_000, "gpt-5.4");
    const level = computeAutoDetailLevel(db, 1, undefined);
    expect(level).toBeNull();
  });

  it("returns null when registry returns 0 or negative window", () => {
    insertTelemetry(db, 1, 1_000, "gpt-5.4");
    expect(computeAutoDetailLevel(db, 1, () => 0)).toBeNull();
    expect(computeAutoDetailLevel(db, 1, () => -5)).toBeNull();
  });

  it("returns 0 when remaining context is exhausted", () => {
    // 200k context, 200k used → remaining ≤ 0 → tier 0.
    insertTelemetry(db, 1, 200_000, "gpt-5.4");
    expect(computeAutoDetailLevel(db, 1, () => 200_000)).toBe(0);
  });

  // Boundary: AUTO_DETAIL_LEVEL_THRESHOLDS = [{100k→3}, {50k→2}, {20k→1}],
  // safety reserve = 20% of contextWindow. We pick contextWindow=1_000_000
  // so the safety reserve is 200k and `remaining = 1M - tokens - 200k`.
  // We then choose `tokens` so that `remaining` lands at the boundary.
  // remaining = 100_000 → tokens = 700_000 → tier 3.
  // remaining = 99_999  → tokens = 700_001 → tier 2.
  // remaining = 50_000  → tokens = 750_000 → tier 2.
  // remaining = 49_999  → tokens = 750_001 → tier 1.
  // remaining = 20_000  → tokens = 780_000 → tier 1.
  // remaining = 19_999  → tokens = 780_001 → tier 0.
  it("picks tier 3 when remaining ≥ 100k", () => {
    insertTelemetry(db, 1, 700_000, "x");
    expect(computeAutoDetailLevel(db, 1, () => 1_000_000)).toBe(3);
  });

  it("picks tier 2 when 50k ≤ remaining < 100k", () => {
    insertTelemetry(db, 1, 700_001, "x");
    expect(computeAutoDetailLevel(db, 1, () => 1_000_000)).toBe(2);
    insertTelemetry(db, 2, 750_000, "x");
    expect(computeAutoDetailLevel(db, 2, () => 1_000_000)).toBe(2);
  });

  it("picks tier 1 when 20k ≤ remaining < 50k", () => {
    insertTelemetry(db, 1, 750_001, "x");
    expect(computeAutoDetailLevel(db, 1, () => 1_000_000)).toBe(1);
    insertTelemetry(db, 2, 780_000, "x");
    expect(computeAutoDetailLevel(db, 2, () => 1_000_000)).toBe(1);
  });

  it("picks tier 0 when remaining < 20k but > 0", () => {
    insertTelemetry(db, 1, 780_001, "x");
    expect(computeAutoDetailLevel(db, 1, () => 1_000_000)).toBe(0);
  });

  it("treats negative or zero telemetry tokens as 0 used", () => {
    // No usage → all of contextWindow minus safety reserve is remaining.
    insertTelemetry(db, 1, -100, "gpt-5.4");
    expect(computeAutoDetailLevel(db, 1, () => 200_000)).toBe(3);
    insertTelemetry(db, 2, null, "gpt-5.4");
    expect(computeAutoDetailLevel(db, 2, () => 200_000)).toBe(3);
  });
});

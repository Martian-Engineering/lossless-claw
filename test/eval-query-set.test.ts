import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import {
  decodeQuerySetId,
  encodeQuerySetId,
  getQuerySet,
  listQuerySets,
  registerQuerySet,
  type QueryRecord,
  type QuerySetIdentity,
} from "../src/eval/query-set.js";

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  runLcmMigrations(db, { fts5Available: false });
  return db;
}

const SAMPLE_QUERIES: QueryRecord[] = [
  {
    queryId: "q1",
    queryText: "what tables hold session metadata",
    stratum: "fts-easy",
    expectedSummaryIds: ["sum_a", "sum_b"],
  },
  {
    queryId: "q2",
    queryText: "how does the compaction worker decide to run",
    stratum: "fts-medium",
    referenceSummary: "Compaction runs after each stop event...",
  },
  {
    queryId: "q3",
    queryText: "where is the budget enforced",
    stratum: "paraphrastic",
    referenceSummary: "Budget enforcement happens in dispatch.ts.",
    expectedSummaryIds: ["sum_c"],
  },
];

describe("eval/query-set — id encoding", () => {
  it("encodes name+version as name@vN", () => {
    expect(encodeQuerySetId({ name: "eva-baseline", version: 2 })).toBe("eva-baseline@v2");
  });

  it("decodes back round-trip", () => {
    const id = encodeQuerySetId({ name: "eva-baseline", version: 7 });
    expect(decodeQuerySetId(id)).toEqual({ name: "eva-baseline", version: 7 });
  });

  it("round-trips names that contain @v themselves (uses lastIndexOf)", () => {
    const id = encodeQuerySetId({ name: "weird@vname", version: 1 });
    expect(id).toBe("weird@vname@v1");
    expect(decodeQuerySetId(id)).toEqual({ name: "weird@vname", version: 1 });
  });

  it("rejects empty name", () => {
    expect(() => encodeQuerySetId({ name: "", version: 1 })).toThrow(/non-empty/);
  });

  it("rejects non-positive version", () => {
    expect(() => encodeQuerySetId({ name: "x", version: 0 })).toThrow(/positive integer/);
    expect(() => encodeQuerySetId({ name: "x", version: -1 })).toThrow(/positive integer/);
    expect(() => encodeQuerySetId({ name: "x", version: 1.5 })).toThrow(/positive integer/);
  });

  it("rejects malformed query_set_id on decode", () => {
    expect(() => decodeQuerySetId("no-separator")).toThrow(/malformed/);
    expect(() => decodeQuerySetId("@v1")).toThrow(/malformed/);
    expect(() => decodeQuerySetId("name@vfoo")).toThrow(/malformed/);
  });
});

describe("eval/query-set — register + lookup", () => {
  it("registers and reads back a fresh set", () => {
    const db = setupDb();
    const identity: QuerySetIdentity = { name: "eva-baseline", version: 1 };
    registerQuerySet(db, identity, SAMPLE_QUERIES);

    const out = getQuerySet(db, identity);
    expect(out).not.toBeNull();
    expect(out!.identity).toEqual(identity);
    expect(out!.queries).toHaveLength(3);

    // Queries should come back in queryId order (stable iteration).
    expect(out!.queries.map((q) => q.queryId)).toEqual(["q1", "q2", "q3"]);

    const q1 = out!.queries.find((q) => q.queryId === "q1")!;
    expect(q1.queryText).toBe("what tables hold session metadata");
    expect(q1.stratum).toBe("fts-easy");
    expect(q1.expectedSummaryIds).toEqual(["sum_a", "sum_b"]);
    expect(q1.referenceSummary).toBeUndefined();

    const q2 = out!.queries.find((q) => q.queryId === "q2")!;
    expect(q2.referenceSummary).toBe("Compaction runs after each stop event...");
    expect(q2.expectedSummaryIds).toBeUndefined();

    const q3 = out!.queries.find((q) => q.queryId === "q3")!;
    expect(q3.referenceSummary).toBe("Budget enforcement happens in dispatch.ts.");
    expect(q3.expectedSummaryIds).toEqual(["sum_c"]);
  });

  it("returns null for unknown identity", () => {
    const db = setupDb();
    expect(getQuerySet(db, { name: "missing", version: 1 })).toBeNull();
  });

  it("is idempotent on re-register with identical content", () => {
    const db = setupDb();
    const identity: QuerySetIdentity = { name: "eva-baseline", version: 1 };
    registerQuerySet(db, identity, SAMPLE_QUERIES);
    // Re-register with a shuffled copy — same content, different order.
    const shuffled = [SAMPLE_QUERIES[2]!, SAMPLE_QUERIES[0]!, SAMPLE_QUERIES[1]!];
    expect(() => registerQuerySet(db, identity, shuffled)).not.toThrow();
    const out = getQuerySet(db, identity);
    expect(out!.queries).toHaveLength(3);
  });

  it("throws on re-register with different content under same identity", () => {
    const db = setupDb();
    const identity: QuerySetIdentity = { name: "eva-baseline", version: 1 };
    registerQuerySet(db, identity, SAMPLE_QUERIES);
    const mutated: QueryRecord[] = [
      { ...SAMPLE_QUERIES[0]!, queryText: "DIFFERENT TEXT" },
      ...SAMPLE_QUERIES.slice(1),
    ];
    expect(() => registerQuerySet(db, identity, mutated)).toThrow(/different content/);
  });

  it("isolates versions — name@v1 and name@v2 are independent", () => {
    const db = setupDb();
    registerQuerySet(db, { name: "x", version: 1 }, SAMPLE_QUERIES);
    const v2Queries: QueryRecord[] = [
      { queryId: "qNEW", queryText: "v2 query", stratum: "fts-easy" },
    ];
    registerQuerySet(db, { name: "x", version: 2 }, v2Queries);

    const v1 = getQuerySet(db, { name: "x", version: 1 });
    const v2 = getQuerySet(db, { name: "x", version: 2 });
    expect(v1!.queries).toHaveLength(3);
    expect(v2!.queries).toHaveLength(1);
    expect(v2!.queries[0]!.queryId).toBe("qNEW");
  });

  it("rejects empty query set", () => {
    const db = setupDb();
    expect(() => registerQuerySet(db, { name: "x", version: 1 }, [])).toThrow(/empty/);
  });

  it("rejects duplicate queryId within a set", () => {
    const db = setupDb();
    const dupes: QueryRecord[] = [
      { queryId: "dup", queryText: "a", stratum: "fts-easy" },
      { queryId: "dup", queryText: "b", stratum: "fts-medium" },
    ];
    expect(() => registerQuerySet(db, { name: "x", version: 1 }, dupes)).toThrow(/duplicate/);
  });

  it("rejects bad stratum", () => {
    const db = setupDb();
    const bad: QueryRecord[] = [
      { queryId: "q", queryText: "a", stratum: "nonsense" as never },
    ];
    expect(() => registerQuerySet(db, { name: "x", version: 1 }, bad)).toThrow(/stratum/);
  });

  it("rejects empty queryText", () => {
    const db = setupDb();
    const bad: QueryRecord[] = [{ queryId: "q", queryText: "", stratum: "fts-easy" }];
    expect(() => registerQuerySet(db, { name: "x", version: 1 }, bad)).toThrow(/empty queryText/);
  });

  it("rolls back on failure (no partial write)", () => {
    const db = setupDb();
    // Create a name conflict to force a half-way failure: register v1, then
    // try to register again with mutated content while a v2 NOT yet inserted.
    registerQuerySet(db, { name: "x", version: 1 }, SAMPLE_QUERIES);
    const mutated: QueryRecord[] = [
      { ...SAMPLE_QUERIES[0]!, queryText: "DIFFERENT" },
      ...SAMPLE_QUERIES.slice(1),
    ];
    expect(() => registerQuerySet(db, { name: "x", version: 1 }, mutated)).toThrow();
    // v1 should still have ORIGINAL content.
    const out = getQuerySet(db, { name: "x", version: 1 });
    expect(out!.queries.find((q) => q.queryId === "q1")!.queryText).toBe(
      "what tables hold session metadata",
    );
  });
});

describe("eval/query-set — listQuerySets", () => {
  it("returns empty for fresh DB", () => {
    const db = setupDb();
    expect(listQuerySets(db)).toEqual([]);
  });

  it("lists all registered sets sorted by id", () => {
    const db = setupDb();
    registerQuerySet(db, { name: "alpha", version: 1 }, SAMPLE_QUERIES);
    registerQuerySet(db, { name: "alpha", version: 2 }, SAMPLE_QUERIES);
    registerQuerySet(db, { name: "beta", version: 1 }, SAMPLE_QUERIES);

    const all = listQuerySets(db);
    expect(all).toEqual([
      { name: "alpha", version: 1 },
      { name: "alpha", version: 2 },
      { name: "beta", version: 1 },
    ]);
  });
});

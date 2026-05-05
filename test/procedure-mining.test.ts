import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import {
  mineProceduresPass,
  type CandidateLeaf,
  type JudgeProcedureCluster,
} from "../src/extraction/procedure-mining.js";

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  runLcmMigrations(db, { fts5Available: false });
  return db;
}

function makeLeaf(id: string, content: string, vec: [number, number, number]): CandidateLeaf {
  return {
    summaryId: id,
    sessionKey: "sk1",
    content,
    vector: new Float32Array(vec),
  };
}

const PROCEDURE_CONTENT = `
How to deploy:
1. Run \`git pull\`
2. Run \`pnpm install\`
3. Run \`pnpm build\`
First, push the branch. Then, run the pipeline.
`;

describe("procedure-mining — basic happy path", () => {
  it("clusters 8+ procedure-shaped leaves, judge confirms, writes status='active'", async () => {
    const db = setupDb();

    // 10 candidates with similar embedding (all near [0.1, 0.1, 0.1])
    const leaves: CandidateLeaf[] = [];
    for (let i = 0; i < 10; i++) {
      leaves.push(makeLeaf(`leaf_${i}`, PROCEDURE_CONTENT, [0.1, 0.1, 0.1]));
    }

    const judge: JudgeProcedureCluster = async ({ cluster }) => ({
      confirmed: true,
      confidence: 0.95,
      procedureName: "Deploy script",
      steps: "git pull; pnpm install; pnpm build",
      reason: `${cluster.leaves.length}-member cluster`,
    });

    const report = await mineProceduresPass(db, leaves, judge, {
      sessionKey: "sk1",
      passId: "pass-test-1",
    });

    expect(report.candidateCount).toBe(10);
    expect(report.largeClusterCount).toBeGreaterThan(0);
    expect(report.activeProceduresWritten).toBeGreaterThan(0);
    expect(report.judgeRejected).toBe(0);

    const procRows = db
      .prepare(`SELECT name, status, confidence, occurrence_count FROM lcm_procedures`)
      .all() as Array<{ name: string; status: string; confidence: number; occurrence_count: number }>;
    expect(procRows.length).toBeGreaterThan(0);
    expect(procRows[0].name).toBe("Deploy script");
    expect(procRows[0].status).toBe("active");
    expect(procRows[0].confidence).toBe(0.95);
    db.close();
  });
});

describe("procedure-mining — confidence threshold splits active vs draft", () => {
  it("judge confidence < minConfidence (0.9) writes status='draft'", async () => {
    const db = setupDb();
    const leaves = Array.from({ length: 8 }, (_, i) =>
      makeLeaf(`leaf_${i}`, PROCEDURE_CONTENT, [0.1, 0.1, 0.1]),
    );
    const judge: JudgeProcedureCluster = async () => ({
      confirmed: true,
      confidence: 0.7, // below minConfidence
      procedureName: "Maybe a procedure",
      steps: "x",
    });
    const report = await mineProceduresPass(db, leaves, judge, {
      sessionKey: "sk1",
      passId: "p1",
    });
    expect(report.activeProceduresWritten).toBe(0);
    expect(report.draftProceduresWritten).toBeGreaterThan(0);

    const status = (
      db.prepare(`SELECT status FROM lcm_procedures`).get() as { status: string }
    ).status;
    expect(status).toBe("draft");
    db.close();
  });
});

describe("procedure-mining — judge declines / errors", () => {
  it("judge.confirmed=false → no procedure written, judgeRejected++", async () => {
    const db = setupDb();
    const leaves = Array.from({ length: 8 }, (_, i) =>
      makeLeaf(`leaf_${i}`, PROCEDURE_CONTENT, [0.1, 0.1, 0.1]),
    );
    const judge: JudgeProcedureCluster = async () => ({
      confirmed: false,
      confidence: 0.3,
      reason: "doesn't look like a real procedure",
    });
    const report = await mineProceduresPass(db, leaves, judge, {
      sessionKey: "sk1",
      passId: "p2",
    });
    expect(report.activeProceduresWritten).toBe(0);
    expect(report.draftProceduresWritten).toBe(0);
    expect(report.judgeRejected).toBe(1);

    const procCount = (
      db.prepare(`SELECT COUNT(*) AS n FROM lcm_procedures`).get() as { n: number }
    ).n;
    expect(procCount).toBe(0);
    db.close();
  });

  it("judge throws → cluster skipped with skipReason, mining continues", async () => {
    const db = setupDb();
    // Two ORTHOGONAL clusters of 8 (cosine distance 1 = max apart)
    const leaves: CandidateLeaf[] = [];
    for (let i = 0; i < 8; i++) {
      leaves.push(makeLeaf(`leaf_a_${i}`, PROCEDURE_CONTENT, [1, 0, 0]));
    }
    for (let i = 0; i < 8; i++) {
      leaves.push(makeLeaf(`leaf_b_${i}`, PROCEDURE_CONTENT, [0, 1, 0]));
    }
    let calls = 0;
    const judge: JudgeProcedureCluster = async ({ cluster }) => {
      calls++;
      if (calls === 1) throw new Error("judge timeout");
      return {
        confirmed: true,
        confidence: 0.95,
        procedureName: `proc-${cluster.clusterId}`,
        steps: "x",
      };
    };
    const report = await mineProceduresPass(db, leaves, judge, {
      sessionKey: "sk1",
      passId: "p3",
      cutHeight: 0.5, // orthogonal vectors have distance 1, so they split at cutHeight 0.5
    });
    // 1 cluster failed (judge threw), 1 cluster succeeded
    expect(report.activeProceduresWritten).toBe(1);
    const errClusters = report.clusters.filter((c) => c.skipReason?.startsWith("judge-error"));
    expect(errClusters.length).toBe(1);
    db.close();
  });
});

describe("procedure-mining — small clusters skipped", () => {
  it("clusters below minOccurrences get skipReason='below-min-occurrences'", async () => {
    const db = setupDb();
    // 5 leaves — below default minOccurrences (8)
    const leaves = Array.from({ length: 5 }, (_, i) =>
      makeLeaf(`leaf_${i}`, PROCEDURE_CONTENT, [0.1, 0.1, 0.1]),
    );
    let judgeCalled = 0;
    const judge: JudgeProcedureCluster = async () => {
      judgeCalled++;
      return { confirmed: true, confidence: 1.0 };
    };
    const report = await mineProceduresPass(db, leaves, judge, {
      sessionKey: "sk1",
      passId: "p4",
    });
    expect(judgeCalled).toBe(0); // judge never called for small clusters
    expect(report.largeClusterCount).toBe(0);
    db.close();
  });

  it("operator can lower minOccurrences for small-corpus testing", async () => {
    const db = setupDb();
    const leaves = Array.from({ length: 4 }, (_, i) =>
      makeLeaf(`leaf_${i}`, PROCEDURE_CONTENT, [0.1, 0.1, 0.1]),
    );
    const judge: JudgeProcedureCluster = async () => ({
      confirmed: true,
      confidence: 0.95,
      procedureName: "x",
      steps: "y",
    });
    const report = await mineProceduresPass(db, leaves, judge, {
      sessionKey: "sk1",
      passId: "p5",
      minOccurrences: 4,
    });
    expect(report.activeProceduresWritten).toBeGreaterThan(0);
    db.close();
  });
});

describe("procedure-mining — defense-in-depth pre-filter", () => {
  it("non-procedure-shaped leaves filtered out even if caller passed them", async () => {
    const db = setupDb();
    // All these are conversational, not procedural
    const leaves = Array.from({ length: 10 }, (_, i) =>
      makeLeaf(`leaf_${i}`, "Just some conversation. We talked. It went well.", [0.1, 0.1, 0.1]),
    );
    const judge: JudgeProcedureCluster = async () => ({ confirmed: true, confidence: 1 });
    const report = await mineProceduresPass(db, leaves, judge, {
      sessionKey: "sk1",
      passId: "p6",
    });
    expect(report.candidateCount).toBe(10); // input count
    // All filtered out by prefilter — nothing reaches clustering
    expect(report.clusterCount).toBe(0);
    expect(report.activeProceduresWritten).toBe(0);
    db.close();
  });
});

describe("procedure-mining — duplicate handling", () => {
  it("dedupes by summaryId", async () => {
    const db = setupDb();
    // Pass the same leaf 10 times
    const leaves = Array.from({ length: 10 }, () =>
      makeLeaf("leaf_dup", PROCEDURE_CONTENT, [0.1, 0.1, 0.1]),
    );
    const judge: JudgeProcedureCluster = async () => ({
      confirmed: true,
      confidence: 1,
      procedureName: "x",
    });
    const report = await mineProceduresPass(db, leaves, judge, {
      sessionKey: "sk1",
      passId: "p7",
      minOccurrences: 1, // even with min=1, dedupe should leave only 1 leaf
    });
    // After dedupe: 1 leaf — but minOccurrences: 1 lets it through; cluster
    // of size 1 → judge called, procedure written (occurrence_count=1)
    expect(report.candidateCount).toBe(10);
    if (report.activeProceduresWritten > 0) {
      const occ = (
        db.prepare(`SELECT occurrence_count FROM lcm_procedures`).get() as {
          occurrence_count: number;
        }
      ).occurrence_count;
      expect(occ).toBe(1); // only 1 unique leaf
    }
    db.close();
  });
});

describe("procedure-mining — empty / tiny input", () => {
  it("returns empty report when fewer candidates than minOccurrences", async () => {
    const db = setupDb();
    const judge: JudgeProcedureCluster = async () => ({ confirmed: true, confidence: 1 });
    const report = await mineProceduresPass(db, [], judge, {
      sessionKey: "sk1",
      passId: "p8",
    });
    expect(report.candidateCount).toBe(0);
    expect(report.activeProceduresWritten).toBe(0);
    db.close();
  });
});

import { afterAll, describe, expect, it } from "vitest";
import {
  agentHasRole,
  assignKnowledgeRole,
  ensureSharedKnowledgeTables,
  listKnowledgeRoles,
  resetSharedKnowledgeEnsureCacheForTests,
  searchMirror,
  revokeKnowledgeRole,
  searchSharedKnowledge,
  seedKnowledgeRoles,
  writeSharedKnowledge,
} from "../src/mirror/pg-reader.js";
import { closeAllMirrorPools, upsertLcmMirrorRow } from "../src/mirror/pg-sink.js";

const pgUrl = process.env.TEST_PG_URL;
const describePg = pgUrl ? describe : describe.skip;

describePg("pg-reader integration (requires TEST_PG_URL)", () => {
  afterAll(async () => {
    resetSharedKnowledgeEnsureCacheForTests();
    await closeAllMirrorPools();
  });

  it("ensureSharedKnowledgeTables creates role/knowledge tables", async () => {
    await ensureSharedKnowledgeTables(pgUrl!);
    const pg = await import("pg");
    const pool = new pg.Pool({ connectionString: pgUrl!, max: 1 });
    const result = await pool.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('knowledge_roles', 'shared_knowledge')
       ORDER BY table_name`,
    );
    await pool.end();
    expect(result.rows.map((row) => row.table_name)).toEqual(["knowledge_roles", "shared_knowledge"]);
  });

  it("ensureSharedKnowledgeTables enforces FORCE ROW LEVEL SECURITY on shared_knowledge", async () => {
    await ensureSharedKnowledgeTables(pgUrl!);
    const pg = await import("pg");
    const pool = new pg.Pool({ connectionString: pgUrl!, max: 1 });
    const result = await pool.query(
      `SELECT c.relrowsecurity, c.relforcerowsecurity
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = 'shared_knowledge'
       LIMIT 1`,
    );
    await pool.end();
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.relrowsecurity).toBe(true);
    expect(result.rows[0]?.relforcerowsecurity).toBe(true);
  });

  it("role CRUD works and is idempotent", async () => {
    const runId = Date.now().toString(36);
    const agentId = `agent_${runId}`;
    await ensureSharedKnowledgeTables(pgUrl!);
    await assignKnowledgeRole(pgUrl!, { agentId, role: "researcher" });
    await assignKnowledgeRole(pgUrl!, { agentId, role: "researcher" });

    const hasRole = await agentHasRole(pgUrl!, { agentId, role: "researcher" });
    expect(hasRole).toBe(true);

    const list = await listKnowledgeRoles(pgUrl!);
    expect(list.some((row) => row.agentId === agentId && row.role === "researcher")).toBe(true);

    const revoke = await revokeKnowledgeRole(pgUrl!, { agentId, role: "researcher" });
    expect(revoke.deleted).toBe(true);
    const hasAfter = await agentHasRole(pgUrl!, { agentId, role: "researcher" });
    expect(hasAfter).toBe(false);
  });

  it("write/search shared knowledge respects role-based visibility", async () => {
    const runId = Date.now().toString(36);
    const adminAgent = `main_${runId}`;
    const researchAgent = `research_${runId}`;
    await ensureSharedKnowledgeTables(pgUrl!);
    await seedKnowledgeRoles(pgUrl!, {
      [adminAgent]: ["admin"],
      [researchAgent]: ["researcher"],
    });

    await writeSharedKnowledge(pgUrl!, {
      agentId: adminAgent,
      adminRoleName: "admin",
      content: `API rate limit is 100 req/min (${runId})`,
      title: `Rate Limit ${runId}`,
      visibility: "restricted",
      visibleTo: ["researcher"],
      editableBy: ["admin"],
      tags: ["api", runId],
    });

    const asResearch = await searchSharedKnowledge(pgUrl!, {
      agentId: researchAgent,
      adminRoleName: "admin",
      query: runId,
      limit: 10,
    });
    expect(asResearch.length).toBeGreaterThan(0);
    expect(asResearch.some((row) => row.tags.includes(runId))).toBe(true);
  });

  it("searchMirror returns partial rows and errors when one database URL fails", async () => {
    const runId = Date.now().toString(36);
    await upsertLcmMirrorRow(pgUrl!, {
      sessionKey: `agent:main:${runId}`,
      sessionId: `session-${runId}`,
      conversationId: Number(Date.now()),
      agentId: "main",
      mode: "latest_nodes",
      content: `Partial search payload ${runId}`,
      summaryIds: [],
      contentHash: `partial-${runId}`,
      capturedAtIso: new Date().toISOString(),
    });

    const invalidUrl = "postgresql://localhost:65536/lcm_bad";
    const result = await searchMirror([pgUrl!, invalidUrl], {
      query: runId,
      limit: 10,
    });
    expect(result.rows.some((row) => row.content.includes(runId))).toBe(true);
    expect(result.errors.some((entry) => entry.sourceUrl === invalidUrl)).toBe(true);
  });

  it("searchSharedKnowledge treats % and _ in query as literal characters", async () => {
    const runId = Date.now().toString(36);
    const adminAgent = `main_${runId}`;
    await ensureSharedKnowledgeTables(pgUrl!);
    await seedKnowledgeRoles(pgUrl!, {
      [adminAgent]: ["admin"],
    });

    await writeSharedKnowledge(pgUrl!, {
      agentId: adminAgent,
      adminRoleName: "admin",
      content: `literal percent ${runId}`,
      title: `Percent 100% ${runId}`,
      visibility: "shared",
      tags: [runId],
    });
    await writeSharedKnowledge(pgUrl!, {
      agentId: adminAgent,
      adminRoleName: "admin",
      content: `literal underscore ${runId}`,
      title: `Under score a_b ${runId}`,
      visibility: "shared",
      tags: [runId],
    });
    await writeSharedKnowledge(pgUrl!, {
      agentId: adminAgent,
      adminRoleName: "admin",
      content: `control row ${runId}`,
      title: `Percent 100X ${runId}`,
      visibility: "shared",
      tags: [runId],
    });
    await writeSharedKnowledge(pgUrl!, {
      agentId: adminAgent,
      adminRoleName: "admin",
      content: `control row two ${runId}`,
      title: `Under score aXb ${runId}`,
      visibility: "shared",
      tags: [runId],
    });

    const percentQueryRows = await searchSharedKnowledge(pgUrl!, {
      agentId: adminAgent,
      adminRoleName: "admin",
      query: `100% ${runId}`,
      limit: 20,
    });
    expect(percentQueryRows.some((row) => row.title?.includes("100%"))).toBe(true);
    expect(percentQueryRows.some((row) => row.title?.includes("100X"))).toBe(false);

    const underscoreQueryRows = await searchSharedKnowledge(pgUrl!, {
      agentId: adminAgent,
      adminRoleName: "admin",
      query: `a_b ${runId}`,
      limit: 20,
    });
    expect(underscoreQueryRows.some((row) => row.title?.includes("a_b"))).toBe(true);
    expect(underscoreQueryRows.some((row) => row.title?.includes("aXb"))).toBe(false);
  });
});

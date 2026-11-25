import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bindRuntimeExpansionGrantDatabase,
  createDelegatedExpansionGrant,
  getRuntimeExpansionAuthManager,
  resolveDelegatedExpansionGrantId,
  revokeDelegatedExpansionGrantForSession,
} from "../src/expansion-auth.js";
import { withDatabaseTransaction } from "../src/transaction-mutex.js";

/**
 * Open a transaction on the shared connection that stays open across an
 * await, the way store transactions hold BEGIN while awaiting file I/O, and
 * roll it back once released.
 */
function holdRolledBackTransaction(db: DatabaseSync): {
  entered: Promise<void>;
  release: () => void;
  settled: Promise<unknown>;
} {
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const settled = withDatabaseTransaction(db, "BEGIN IMMEDIATE", async () => {
    db.prepare(`INSERT INTO unrelated_work (note) VALUES (?)`).run("rolled back");
    markEntered();
    await gate;
    throw new Error("unrelated work failed");
  }).catch((error: unknown) => error);
  return { entered, release, settled };
}

describe("runtime expansion grants on a shared connection", () => {
  let db: DatabaseSync;
  let unbind: () => void;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE unrelated_work (note TEXT NOT NULL)`);
    unbind = bindRuntimeExpansionGrantDatabase(db);
  });

  afterEach(() => {
    unbind();
    db.close();
  });

  it("keeps a grant created while another path holds an open transaction", async () => {
    const foreign = holdRolledBackTransaction(db);
    await foreign.entered;

    const created = Promise.resolve(
      createDelegatedExpansionGrant({
        delegatedSessionKey: "agent:main:subagent:child",
        issuerSessionId: "agent:main:main",
        allowedConversationIds: [1],
      }),
    );

    foreign.release();
    expect(await foreign.settled).toBeInstanceOf(Error);
    const grant = await created;

    expect(db.prepare(`SELECT COUNT(*) AS n FROM unrelated_work`).get()).toEqual({ n: 0 });
    expect(resolveDelegatedExpansionGrantId("agent:main:subagent:child")).toBe(grant.grantId);
    expect(getRuntimeExpansionAuthManager().getGrant(grant.grantId)).not.toBeNull();
  });

  it("keeps a revocation issued while another path holds an open transaction", async () => {
    const grant = await createDelegatedExpansionGrant({
      delegatedSessionKey: "agent:main:subagent:child",
      issuerSessionId: "agent:main:main",
      allowedConversationIds: [1],
    });

    const foreign = holdRolledBackTransaction(db);
    await foreign.entered;

    const revoked = Promise.resolve(
      revokeDelegatedExpansionGrantForSession("agent:main:subagent:child"),
    );

    foreign.release();
    expect(await foreign.settled).toBeInstanceOf(Error);
    expect(await revoked).toBe(true);

    expect(getRuntimeExpansionAuthManager().getGrant(grant.grantId)).toBeNull();
    expect(
      getRuntimeExpansionAuthManager().validateExpansion(grant.grantId, {
        conversationId: 1,
        summaryIds: [],
        depth: 1,
        tokenCap: 1,
      }),
    ).toEqual({ valid: false, reason: "Grant has been revoked" });
  });

  it("runs grant writes inside a caller's own transaction scope", async () => {
    const grant = await withDatabaseTransaction(db, "BEGIN IMMEDIATE", async () =>
      createDelegatedExpansionGrant({
        delegatedSessionKey: "agent:main:subagent:nested",
        issuerSessionId: "agent:main:main",
        allowedConversationIds: [1],
      }),
    );

    expect(resolveDelegatedExpansionGrantId("agent:main:subagent:nested")).toBe(grant.grantId);
  });
});

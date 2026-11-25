// Busy or locked SQLite during delegated expansion-grant writes must not make
// the subagent hooks throw, because the host quarantines the engine on throw.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isSqliteBusyError } from "../src/db/sqlite-errors.js";
import {
  createDelegatedExpansionGrant,
  getRuntimeExpansionAuthManager,
  resolveDelegatedExpansionGrantId,
} from "../src/expansion-auth.js";
import {
  cleanupEngineTestState,
  createEngineWithDeps,
  makeMessage,
  tempDirs,
} from "./helpers.js";

afterEach(() => {
  cleanupEngineTestState();
});

/** Produce the error node:sqlite throws when another connection holds the write lock. */
function captureRealBusyError(): Error {
  const dir = mkdtempSync(join(tmpdir(), "lossless-claw-busy-"));
  tempDirs.push(dir);
  const path = join(dir, "busy.db");
  const holder = new DatabaseSync(path);
  const writer = new DatabaseSync(path);
  try {
    holder.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (x INTEGER)");
    writer.exec("PRAGMA busy_timeout = 0");
    holder.exec("BEGIN EXCLUSIVE");
    try {
      writer.prepare("INSERT INTO t VALUES (1)").run();
    } catch (error) {
      return error as Error;
    } finally {
      holder.exec("ROLLBACK");
    }
    throw new Error("expected the second writer to hit SQLITE_BUSY");
  } finally {
    writer.close();
    holder.close();
  }
}

function createEngineWithLog() {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const engine = createEngineWithDeps({}, { log });
  return { engine, log };
}

async function seedParentConversation(
  engine: ReturnType<typeof createEngineWithDeps>,
  parentSessionKey: string,
): Promise<void> {
  await engine.ingest({
    sessionId: `runtime-${parentSessionKey}`,
    sessionKey: parentSessionKey,
    message: makeMessage({ role: "user", content: "parent context" }),
  });
}

/** The active grant delegated tools would see for a child session key. */
function activeGrantFor(childSessionKey: string) {
  const grantId = resolveDelegatedExpansionGrantId(childSessionKey);
  return grantId ? getRuntimeExpansionAuthManager().getGrant(grantId) : null;
}

/** The binding stored in the database, ignoring in-memory suppression. */
function storedBindingFor(childSessionKey: string): string | null {
  return getRuntimeExpansionAuthManager().resolveSessionGrantId(childSessionKey);
}

function storedActiveGrantFor(childSessionKey: string) {
  const grantId = storedBindingFor(childSessionKey);
  return grantId ? getRuntimeExpansionAuthManager().getGrant(grantId) : null;
}

describe("isSqliteBusyError", () => {
  it("recognizes the node:sqlite busy error", () => {
    const error = captureRealBusyError();
    expect(error.message).toMatch(/database is locked/);
    expect(isSqliteBusyError(error)).toBe(true);
  });

  it("recognizes extended busy and locked result codes", () => {
    // SQLITE_BUSY_RECOVERY (261) and SQLITE_LOCKED_SHAREDCACHE (262).
    expect(isSqliteBusyError(Object.assign(new Error("x"), { errcode: 261 }))).toBe(true);
    expect(isSqliteBusyError(Object.assign(new Error("x"), { errcode: 262 }))).toBe(true);
    expect(isSqliteBusyError(new Error("database table is locked"))).toBe(true);
  });

  it("rejects other errors", () => {
    expect(isSqliteBusyError(Object.assign(new Error("constraint failed"), { errcode: 19 }))).toBe(false);
    expect(isSqliteBusyError(new Error("disk I/O error"))).toBe(false);
    expect(isSqliteBusyError("database is locked")).toBe(false);
    expect(isSqliteBusyError(undefined)).toBe(false);
  });
});

describe("LcmContextEngine.onSubagentEnded under a busy database", () => {
  it("defers a busy revocation, warns, and applies it on the next subagent hook", async () => {
    const { engine, log } = createEngineWithLog();
    const busyChild = "agent:main:subagent:busy-child";
    const otherChild = "agent:main:subagent:other-child";
    createDelegatedExpansionGrant({
      delegatedSessionKey: busyChild,
      issuerSessionId: "agent:main:main",
      allowedConversationIds: [1],
    });
    createDelegatedExpansionGrant({
      delegatedSessionKey: otherChild,
      issuerSessionId: "agent:main:main",
      allowedConversationIds: [1],
    });

    const busyError = captureRealBusyError();
    const revokeSpy = vi
      .spyOn(getRuntimeExpansionAuthManager(), "revokeGrant")
      .mockImplementationOnce(() => {
        throw busyError;
      });

    await expect(
      engine.onSubagentEnded({ childSessionKey: busyChild, reason: "completed" }),
    ).resolves.toBeUndefined();
    // The stored grant is still active, but delegated tools no longer resolve it.
    expect(storedActiveGrantFor(busyChild)).not.toBeNull();
    expect(resolveDelegatedExpansionGrantId(busyChild)).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining(`deferring delegated expansion grant cleanup for child=${busyChild}`),
    );

    await engine.onSubagentEnded({ childSessionKey: otherChild, reason: "deleted" });

    expect(revokeSpy).toHaveBeenCalledTimes(3);
    expect(storedActiveGrantFor(busyChild)).toBeNull();
    // "completed" keeps the binding, which now resolves to the revoked grant.
    expect(resolveDelegatedExpansionGrantId(busyChild)).toBe(storedBindingFor(busyChild));
    expect(storedBindingFor(busyChild)).not.toBeNull();
    expect(activeGrantFor(busyChild)).toBeNull();
    expect(storedBindingFor(otherChild)).toBeNull();
  });

  it("merges repeated busy cleanups for one child into a single pending cleanup", async () => {
    const { engine } = createEngineWithLog();
    const child = "agent:main:subagent:merged";
    createDelegatedExpansionGrant({
      delegatedSessionKey: child,
      issuerSessionId: "agent:main:main",
      allowedConversationIds: [1],
    });
    const busyError = captureRealBusyError();
    const manager = getRuntimeExpansionAuthManager();
    vi.spyOn(manager, "revokeGrant").mockImplementationOnce(() => {
      throw busyError;
    });
    vi.spyOn(manager, "removeSessionBinding").mockImplementationOnce(() => {
      throw busyError;
    });

    await engine.onSubagentEnded({ childSessionKey: child, reason: "completed" });
    // The revocation now succeeds but the binding removal is still busy.
    await engine.onSubagentEnded({ childSessionKey: child, reason: "released" });
    expect(storedActiveGrantFor(child)).toBeNull();
    expect(storedBindingFor(child)).not.toBeNull();
    expect(resolveDelegatedExpansionGrantId(child)).toBeNull();

    await engine.onSubagentEnded({ childSessionKey: "agent:main:subagent:unbound", reason: "swept" });
    expect(storedBindingFor(child)).toBeNull();
    expect(resolveDelegatedExpansionGrantId(child)).toBeNull();
  });

  it("rethrows errors that are not busy or locked", async () => {
    const { engine } = createEngineWithLog();
    const child = "agent:main:subagent:broken";
    createDelegatedExpansionGrant({
      delegatedSessionKey: child,
      issuerSessionId: "agent:main:main",
      allowedConversationIds: [1],
    });
    vi.spyOn(getRuntimeExpansionAuthManager(), "revokeGrant").mockImplementationOnce(() => {
      throw new Error("disk I/O error");
    });

    await expect(
      engine.onSubagentEnded({ childSessionKey: child, reason: "deleted" }),
    ).rejects.toThrow("disk I/O error");
  });
});

describe("LcmContextEngine.prepareSubagentSpawn under a busy database", () => {
  const parentSessionKey = "agent:main:main";

  it("spawns without a grant when the grant insert is busy", async () => {
    const { engine, log } = createEngineWithLog();
    const child = "agent:main:subagent:no-grant";
    await seedParentConversation(engine, parentSessionKey);
    const busyError = captureRealBusyError();
    vi.spyOn(getRuntimeExpansionAuthManager(), "createGrant").mockImplementationOnce(() => {
      throw busyError;
    });

    await expect(
      engine.prepareSubagentSpawn({ parentSessionKey, childSessionKey: child }),
    ).resolves.toBeUndefined();
    expect(resolveDelegatedExpansionGrantId(child)).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining(`spawning child=${child} without a delegated expansion grant`),
    );
  });

  it("leaves the child unbound when the binding write is busy", async () => {
    const { engine } = createEngineWithLog();
    const child = "agent:main:subagent:unbound-grant";
    await seedParentConversation(engine, parentSessionKey);
    const busyError = captureRealBusyError();
    vi.spyOn(getRuntimeExpansionAuthManager(), "bindSession").mockImplementationOnce(() => {
      throw busyError;
    });

    await expect(
      engine.prepareSubagentSpawn({ parentSessionKey, childSessionKey: child }),
    ).resolves.toBeUndefined();
    expect(resolveDelegatedExpansionGrantId(child)).toBeNull();
  });

  it("rethrows grant errors that are not busy or locked", async () => {
    const { engine } = createEngineWithLog();
    await seedParentConversation(engine, parentSessionKey);
    vi.spyOn(getRuntimeExpansionAuthManager(), "createGrant").mockImplementationOnce(() => {
      throw new Error("disk I/O error");
    });

    await expect(
      engine.prepareSubagentSpawn({
        parentSessionKey,
        childSessionKey: "agent:main:subagent:broken-spawn",
      }),
    ).rejects.toThrow("disk I/O error");
  });

  it("defers a busy rollback instead of throwing", async () => {
    const { engine, log } = createEngineWithLog();
    const child = "agent:main:subagent:rollback";
    await seedParentConversation(engine, parentSessionKey);
    const preparation = await engine.prepareSubagentSpawn({
      parentSessionKey,
      childSessionKey: child,
    });
    expect(activeGrantFor(child)).not.toBeNull();

    const busyError = captureRealBusyError();
    vi.spyOn(getRuntimeExpansionAuthManager(), "revokeGrant").mockImplementationOnce(() => {
      throw busyError;
    });
    expect(() => preparation?.rollback?.()).not.toThrow();
    expect(storedActiveGrantFor(child)).not.toBeNull();
    expect(activeGrantFor(child)).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("prepareSubagentSpawn rollback: deferring"),
    );

    await engine.prepareSubagentSpawn({
      parentSessionKey,
      childSessionKey: "agent:main:subagent:next",
    });
    expect(storedBindingFor(child)).toBeNull();
    expect(resolveDelegatedExpansionGrantId(child)).toBeNull();
  });

  it("does not fall back to a reused child key's earlier grant when the new grant is busy", async () => {
    const { engine } = createEngineWithLog();
    const child = "agent:main:subagent:reused";
    await seedParentConversation(engine, parentSessionKey);
    // An earlier, broader grant still bound to this key.
    const earlier = createDelegatedExpansionGrant({
      delegatedSessionKey: child,
      issuerSessionId: parentSessionKey,
      allowedConversationIds: [1, 2, 3],
      tokenCap: 1_000_000,
    });

    const busyError = captureRealBusyError();
    vi.spyOn(getRuntimeExpansionAuthManager(), "bindSession").mockImplementationOnce(() => {
      throw busyError;
    });

    await expect(
      engine.prepareSubagentSpawn({ parentSessionKey, childSessionKey: child }),
    ).resolves.toBeUndefined();
    expect(storedBindingFor(child)).toBe(earlier.grantId);
    expect(resolveDelegatedExpansionGrantId(child)).toBeNull();

    await engine.onSubagentEnded({ childSessionKey: "agent:main:subagent:other", reason: "swept" });
    expect(getRuntimeExpansionAuthManager().getGrant(earlier.grantId)).toBeNull();
    expect(storedBindingFor(child)).toBeNull();
    expect(resolveDelegatedExpansionGrantId(child)).toBeNull();
  });

  it("drops a pending cleanup when the same child key gets a fresh grant", async () => {
    const { engine } = createEngineWithLog();
    const child = "agent:main:subagent:respawned";
    await seedParentConversation(engine, parentSessionKey);
    await engine.prepareSubagentSpawn({ parentSessionKey, childSessionKey: child });

    const busyError = captureRealBusyError();
    const manager = getRuntimeExpansionAuthManager();
    // Busy for the ended hook and for the flush at the start of the respawn.
    vi.spyOn(manager, "revokeGrant")
      .mockImplementationOnce(() => {
        throw busyError;
      })
      .mockImplementationOnce(() => {
        throw busyError;
      });
    await engine.onSubagentEnded({ childSessionKey: child, reason: "deleted" });

    await engine.prepareSubagentSpawn({ parentSessionKey, childSessionKey: child });
    const freshGrant = activeGrantFor(child);
    expect(freshGrant).not.toBeNull();

    await engine.onSubagentEnded({ childSessionKey: "agent:main:subagent:other", reason: "swept" });
    expect(activeGrantFor(child)?.grantId).toBe(freshGrant?.grantId);
  });
});

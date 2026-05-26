import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  GATEWAY_BUSY_TIMEOUT_MS,
  GATEWAY_FALLBACK_SOAK_MS,
  WORKER_BUSY_TIMEOUT_MS,
  WORKER_HEARTBEAT_MS,
  WORKER_JOB_KINDS,
  WORKER_LOCK_TTL_MS,
  assertBusyTimeoutForRole,
  assertForeignKeysEnabled,
} from "../src/concurrency/model.js";

describe("concurrency model invariants (v4.1.1 §0)", () => {
  it("worker busy_timeout is shorter than gateway so gateway always wins on contention", () => {
    expect(WORKER_BUSY_TIMEOUT_MS).toBeLessThan(GATEWAY_BUSY_TIMEOUT_MS);
  });

  it("worker lock TTL is at least 3× the heartbeat cadence (allows one missed heartbeat)", () => {
    expect(WORKER_LOCK_TTL_MS).toBeGreaterThanOrEqual(3 * WORKER_HEARTBEAT_MS);
  });

  it("gateway fallback soak window is longer than worker lock TTL (prevents racing slow-LLM workers)", () => {
    expect(GATEWAY_FALLBACK_SOAK_MS).toBeGreaterThan(WORKER_LOCK_TTL_MS);
  });

  it("declares the expected v4.1 worker job kinds (must match docs + future lcm_worker_lock CHECK)", () => {
    expect(WORKER_JOB_KINDS).toContain("condensation");
    expect(WORKER_JOB_KINDS).toContain("extraction");
    expect(WORKER_JOB_KINDS).toContain("embedding-backfill");
    expect(WORKER_JOB_KINDS).toContain("profile-rebuild");
    expect(WORKER_JOB_KINDS).toContain("theme-consolidation");
    expect(WORKER_JOB_KINDS).toContain("eval");
  });
});

describe("assertForeignKeysEnabled (v4.1.1 A6)", () => {
  it("throws when PRAGMA foreign_keys is OFF", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = OFF");
    expect(() => assertForeignKeysEnabled(db)).toThrow(/foreign_keys is not ON/);
    db.close();
  });

  it("passes when PRAGMA foreign_keys is ON", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    expect(() => assertForeignKeysEnabled(db)).not.toThrow();
    db.close();
  });
});

describe("assertBusyTimeoutForRole (v4.1.1 §0)", () => {
  it("throws for gateway role when busy_timeout < gateway threshold", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`PRAGMA busy_timeout = ${GATEWAY_BUSY_TIMEOUT_MS - 1}`);
    expect(() => assertBusyTimeoutForRole(db, "gateway")).toThrow(/busy_timeout for gateway/);
    db.close();
  });

  it("passes for gateway role when busy_timeout = gateway threshold", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`PRAGMA busy_timeout = ${GATEWAY_BUSY_TIMEOUT_MS}`);
    expect(() => assertBusyTimeoutForRole(db, "gateway")).not.toThrow();
    db.close();
  });

  it("throws for worker role when busy_timeout < worker threshold", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`PRAGMA busy_timeout = ${WORKER_BUSY_TIMEOUT_MS - 1}`);
    expect(() => assertBusyTimeoutForRole(db, "worker")).toThrow(/busy_timeout for worker/);
    db.close();
  });

  it("passes for worker role when busy_timeout = worker threshold", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`PRAGMA busy_timeout = ${WORKER_BUSY_TIMEOUT_MS}`);
    expect(() => assertBusyTimeoutForRole(db, "worker")).not.toThrow();
    db.close();
  });
});

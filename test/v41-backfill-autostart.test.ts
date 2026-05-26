import { existsSync } from "node:fs";
import { arch, platform } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import {
  ensureEmbeddingsTable,
  registerEmbeddingProfile,
  tryLoadSqliteVec,
} from "../src/embeddings/store.js";
import { tryStartBackfillAutostart } from "../src/operator/backfill-autostart.js";
import type { BackfillResult } from "../src/embeddings/backfill.js";

const VEC0_PATH =
  process.env.LCM_TEST_VEC0_PATH?.trim() ||
  (() => {
    const realHome = process.env.REAL_HOME?.trim() || "/Users/lume";
    const ext = platform() === "win32" ? "dll" : platform() === "darwin" ? "dylib" : "so";
    const platformPkg = `sqlite-vec-${platform() === "win32" ? "windows" : platform()}-${arch()}`;
    return `${realHome}/.openclaw/extensions/node_modules/${platformPkg}/vec0.${ext}`;
  })();
const VEC0_AVAILABLE = existsSync(VEC0_PATH);

function newLogger(): {
  log: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
  messages: string[];
} {
  const messages: string[] = [];
  return {
    log: {
      info: (m) => messages.push(`INFO ${m}`),
      warn: (m) => messages.push(`WARN ${m}`),
      error: (m) => messages.push(`ERROR ${m}`),
    },
    messages,
  };
}

describe("backfill autostart — pre-flight gating (no live API)", () => {
  it("returns NO_OP_HANDLE when VOYAGE_API_KEY is missing", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    const { log, messages } = newLogger();
    const handle = tryStartBackfillAutostart(db, {
      log,
      env: {} as NodeJS.ProcessEnv,
    });
    expect(handle.isRunning()).toBe(false);
    expect(handle.tickCount()).toBe(0);
    expect(messages.some((m) => m.includes("VOYAGE_API_KEY not set"))).toBe(true);
    db.close();
  });

  it("returns NO_OP_HANDLE when vec0 not loaded (even with key)", () => {
    const db = new DatabaseSync(":memory:"); // no allowExtension
    runLcmMigrations(db, { fts5Available: false });
    const { log, messages } = newLogger();
    const handle = tryStartBackfillAutostart(db, {
      log,
      env: { VOYAGE_API_KEY: "test-key" } as NodeJS.ProcessEnv,
    });
    expect(handle.isRunning()).toBe(false);
    expect(messages.some((m) => m.includes("sqlite-vec extension not loaded"))).toBe(true);
    db.close();
  });
});

describe.skipIf(!VEC0_AVAILABLE)("backfill autostart — vec0-loaded paths", () => {
  it("returns NO_OP_HANDLE when no active embedding profile", () => {
    const db = new DatabaseSync(":memory:", { allowExtension: true });
    tryLoadSqliteVec(db, { path: VEC0_PATH });
    runLcmMigrations(db, { fts5Available: false });
    const { log, messages } = newLogger();
    const handle = tryStartBackfillAutostart(db, {
      log,
      env: { VOYAGE_API_KEY: "test-key" } as NodeJS.ProcessEnv,
    });
    expect(handle.isRunning()).toBe(false);
    expect(messages.some((m) => m.includes("no active embedding profile"))).toBe(true);
    db.close();
  });

  it("starts when all pre-flight passes; returns running handle", async () => {
    const db = new DatabaseSync(":memory:", { allowExtension: true });
    tryLoadSqliteVec(db, { path: VEC0_PATH });
    runLcmMigrations(db, { fts5Available: false });
    registerEmbeddingProfile(db, "voyage-4-large", 3);
    ensureEmbeddingsTable(db, "voyage-4-large", 3);

    const { log, messages } = newLogger();
    let tickCalls = 0;
    const stubTick = async (): Promise<BackfillResult> => {
      tickCalls++;
      return {
        embeddedCount: 0,
        skippedOverCap: 0,
        skipped: [],
        perTickLimitReached: false,
        lockNotAcquired: false,
        voyageTokensConsumed: 0,
        durationMs: 1,
      };
    };
    const handle = tryStartBackfillAutostart(db, {
      log,
      env: { VOYAGE_API_KEY: "test-key" } as NodeJS.ProcessEnv,
      intervalMs: 60, // tight loop for test
      tickFn: stubTick,
    });
    expect(handle.isRunning()).toBe(true);
    expect(messages.some((m) => m.includes("starting"))).toBe(true);

    // Wait long enough for at least 1-2 ticks (initial 5s delay won't fire
    // in this test window, but the interval will)
    await new Promise((r) => setTimeout(r, 200));
    handle.stop();
    // tickCalls may be 0 (interval didn't fire yet) or >0 — either is OK
    // for the smoke check; the important assertion is no crash + handle
    // responds to stop.
    expect(handle.isRunning()).toBe(false);
    db.close();
  });

  it("stop is idempotent + clears handle state", async () => {
    const db = new DatabaseSync(":memory:", { allowExtension: true });
    tryLoadSqliteVec(db, { path: VEC0_PATH });
    runLcmMigrations(db, { fts5Available: false });
    registerEmbeddingProfile(db, "voyage-4-large", 3);
    ensureEmbeddingsTable(db, "voyage-4-large", 3);
    const { log } = newLogger();
    const handle = tryStartBackfillAutostart(db, {
      log,
      env: { VOYAGE_API_KEY: "x" } as NodeJS.ProcessEnv,
      tickFn: async () =>
        ({
          embeddedCount: 0,
          skippedOverCap: 0,
          skipped: [],
          perTickLimitReached: false,
          lockNotAcquired: false,
          voyageTokensConsumed: 0,
          durationMs: 0,
        }) as BackfillResult,
    });
    handle.stop();
    handle.stop(); // idempotent
    handle.stop();
    expect(handle.isRunning()).toBe(false);
    db.close();
  });
});

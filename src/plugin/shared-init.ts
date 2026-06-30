/**
 * Process-global singleton state for LCM plugin initialization.
 *
 * OpenClaw v2026.4.5+ calls plugin register() per-agent-context (main,
 * subagents, cron lanes). Without sharing, each call opens a new DB
 * connection and runs migrations — causing lock storms on large databases.
 *
 * Uses the same globalThis + Symbol.for() pattern as startup-banner-log.ts
 * to ensure one DB connection and engine per database path per process.
 *
 * The shared state stores the waitForEngine/waitForDatabase closures from
 * the first register() call. These closures close over the local init
 * variables (database, lcm, initPromise, etc.) so all subsequent callers
 * share the same deferred init chain without stale-reference issues.
 */
import type { DatabaseSync } from "node:sqlite";
import type { LcmContextEngine } from "../engine.js";

export type SharedLcmInit = {
  /** Whether gateway_stop has been called. */
  stopped: boolean;
  /** Sync accessor — returns the engine if already initialized, null otherwise. */
  getCachedEngine: () => LcmContextEngine | null;
  /** Async accessor for the initialized engine (waits for deferred init). */
  waitForEngine: () => Promise<LcmContextEngine>;
  /** Async accessor for the initialized DB handle (waits for deferred init). */
  waitForDatabase: () => Promise<DatabaseSync>;
};

const SHARED_KEY = Symbol.for(
  "@martian-engineering/lossless-claw/shared-init",
);

function getStore(): Map<string, SharedLcmInit> {
  const g = globalThis as typeof globalThis & {
    [key: symbol]: Map<string, SharedLcmInit> | undefined;
  };
  if (!g[SHARED_KEY]) {
    g[SHARED_KEY] = new Map();
  }
  return g[SHARED_KEY]!;
}

export function getSharedInit(dbPath: string): SharedLcmInit | undefined {
  return getStore().get(dbPath);
}

export function setSharedInit(dbPath: string, init: SharedLcmInit): void {
  getStore().set(dbPath, init);
}

export function removeSharedInit(dbPath: string): void {
  getStore().delete(dbPath);
}

/** Clear all shared init state. Intended for tests only. */
export function clearAllSharedInit(): void {
  getStore().clear();
}

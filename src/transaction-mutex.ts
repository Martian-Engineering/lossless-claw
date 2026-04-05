/**
 * Per-database async transaction mutex.
 *
 * Hotfix for https://github.com/Martian-Engineering/lossless-claw/issues/260
 *
 * Problem: Multiple async operations (from different sessions) share one
 * synchronous DatabaseSync handle. SQLite does not support nested transactions.
 * When two async code paths both try to BEGIN while an earlier BEGIN is still
 * in-flight (awaiting async work inside the transaction), the second BEGIN
 * fails with "cannot start a transaction within a transaction".
 *
 * Solution: A per-database async mutex that serializes all explicit transaction
 * entry points. Uses a WeakMap keyed on the DatabaseSync instance so each
 * database gets its own queue, and databases are garbage-collected normally.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";

interface MutexState {
  /** Tail of the promise chain — each acquirer appends to this. */
  tail: Promise<void>;
}

const mutexMap = new WeakMap<DatabaseSync, MutexState>();
const heldLockContext = new AsyncLocalStorage<Map<DatabaseSync, number>>();

let nextSavepointId = 0;

function getOrCreateMutex(db: DatabaseSync): MutexState {
  let state = mutexMap.get(db);
  if (!state) {
    state = { tail: Promise.resolve() };
    mutexMap.set(db, state);
  }
  return state;
}

function getHeldLockDepth(db: DatabaseSync): number {
  return heldLockContext.getStore()?.get(db) ?? 0;
}

function nextSavepointName(): string {
  nextSavepointId += 1;
  return `lcm_txn_savepoint_${nextSavepointId}`;
}

/**
 * Acquire exclusive async access to the database for a transaction.
 *
 * Direct lock acquisition is intentionally low-level and non-reentrant.
 * Callers that need nested transaction scopes should use
 * `withDatabaseTransaction()`, which reuses the held lock and isolates nested
 * work with SQLite savepoints.
 *
 * Usage:
 *   const release = await acquireTransactionLock(this.db);
 *   try {
 *     this.db.exec("BEGIN IMMEDIATE");
 *     // ... do work ...
 *     this.db.exec("COMMIT");
 *   } catch (err) {
 *     this.db.exec("ROLLBACK");
 *     throw err;
 *   } finally {
 *     release();
 *   }
 *
 * Returns a release function that MUST be called in a finally block.
 */
export function acquireTransactionLock(db: DatabaseSync): Promise<() => void> {
  const mutex = getOrCreateMutex(db);

  let releaseResolve!: () => void;
  const releasePromise = new Promise<void>((resolve) => {
    releaseResolve = resolve;
  });

  // Capture the current tail — we wait on it
  const waitOn = mutex.tail;

  // Advance the tail — next acquirer will wait on our release
  mutex.tail = releasePromise;

  // Wait for the previous holder to release, then return our release fn
  return waitOn.then(() => releaseResolve);
}

export type BeginTransactionStatement = "BEGIN" | "BEGIN IMMEDIATE";

/**
 * Run an operation inside a serialized database transaction.
 *
 * The first scope on an async path acquires the per-database mutex and opens
 * the requested transaction mode. Nested scopes on the same database reuse the
 * held lock and isolate their work with a savepoint instead of hanging.
 */
export async function withDatabaseTransaction<T>(
  db: DatabaseSync,
  beginStatement: BeginTransactionStatement,
  operation: () => Promise<T> | T,
): Promise<T> {
  if (getHeldLockDepth(db) > 0) {
    const savepointName = nextSavepointName();
    db.exec(`SAVEPOINT ${savepointName}`);
    try {
      const result = await operation();
      db.exec(`RELEASE SAVEPOINT ${savepointName}`);
      return result;
    } catch (error) {
      db.exec(`ROLLBACK TO SAVEPOINT ${savepointName}`);
      db.exec(`RELEASE SAVEPOINT ${savepointName}`);
      throw error;
    }
  }

  const release = await acquireTransactionLock(db);
  try {
    const heldLocks = new Map(heldLockContext.getStore() ?? []);
    heldLocks.set(db, (heldLocks.get(db) ?? 0) + 1);

    return await heldLockContext.run(heldLocks, async () => {
      db.exec(beginStatement);
      try {
        const result = await operation();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  } finally {
    release();
  }
}

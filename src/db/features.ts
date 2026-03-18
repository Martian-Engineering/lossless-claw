import type { DatabaseSync } from "node:sqlite";
import type { Backend } from "./dialect.js";

export type LcmDbFeatures = {
  fullTextAvailable: boolean;
  backend: Backend;
};

const featureCache = new WeakMap<DatabaseSync, LcmDbFeatures>();

function probeFts5(db: DatabaseSync): boolean {
  try {
    db.exec("DROP TABLE IF EXISTS temp.__lcm_fts5_probe");
    db.exec("CREATE VIRTUAL TABLE temp.__lcm_fts5_probe USING fts5(content)");
    db.exec("DROP TABLE temp.__lcm_fts5_probe");
    return true;
  } catch {
    try {
      db.exec("DROP TABLE IF EXISTS temp.__lcm_fts5_probe");
    } catch {
      // Ignore cleanup failures after a failed probe.
    }
    return false;
  }
}

/**
 * Detect database features for the configured backend.
 *
 * PostgreSQL: full-text search always available (tsvector is built-in).
 * SQLite: probe for FTS5 at runtime.
 *
 * @param backend  - "sqlite" or "postgres"
 * @param sqliteDb - raw DatabaseSync handle (only needed for SQLite FTS5 probe)
 */
export function getLcmDbFeatures(
  backend: Backend,
  sqliteDb?: DatabaseSync,
): LcmDbFeatures {
  if (backend === "postgres") {
    return { fullTextAvailable: true, backend: "postgres" };
  }

  // SQLite — probe for FTS5 if we have a handle
  if (sqliteDb) {
    const cached = featureCache.get(sqliteDb);
    if (cached) return cached;

    const detected: LcmDbFeatures = {
      fullTextAvailable: probeFts5(sqliteDb),
      backend: "sqlite",
    };
    featureCache.set(sqliteDb, detected);
    return detected;
  }

  return { fullTextAvailable: false, backend: "sqlite" };
}

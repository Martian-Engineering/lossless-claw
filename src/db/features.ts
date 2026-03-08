import type { DatabaseSync } from "node:sqlite";

export type LcmDbFeatures = {
  fts5Available: boolean;
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
 * Detect SQLite features exposed by the current Node runtime.
 *
 * The result is cached per DatabaseSync handle because the probe is runtime-
 * specific, not database-file-specific.
 */
export function getLcmDbFeatures(db: DatabaseSync): LcmDbFeatures {
  const cached = featureCache.get(db);
  if (cached) {
    return cached;
  }

  const detected: LcmDbFeatures = {
    fts5Available: probeFts5(db),
  };
  featureCache.set(db, detected);
  return detected;
}

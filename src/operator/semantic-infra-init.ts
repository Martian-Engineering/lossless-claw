/**
 * Semantic infra init — LCM v4.1 Final.review P1 #1 fix.
 *
 * Wires sqlite-vec extension loading + embedding profile registration
 * into plugin init so the autostart's pre-flight checks actually pass
 * in production. Without this, the entire v4.1 semantic retrieval
 * feature is inert (PR claimed "set VOYAGE_API_KEY and redeploy"
 * works; it didn't until this commit).
 *
 * Called from plugin/index.ts after the migration runs and before
 * autostart fires.
 *
 * Best-effort with graceful degrade:
 *   - sqlite-vec not installed → log warning, return; autostart will
 *     skip semantic + plugin keeps working with FTS-only retrieval
 *   - profile already registered → no-op (idempotent)
 *   - vec0 table already exists → no-op (idempotent)
 *
 * Configuration:
 *   - LCM_EMBEDDING_MODEL env var (default: voyage-4-large)
 *   - LCM_EMBEDDING_DIM env var (default: 1024 for voyage-4-large)
 *   - LCM_DISABLE_SEMANTIC env var: set to 'true' to opt out entirely
 */

import type { DatabaseSync } from "node:sqlite";
import {
  ensureEmbeddingsTable,
  registerEmbeddingProfile,
  tryLoadSqliteVec,
  vec0Version,
} from "../embeddings/store.js";

export interface SemanticInfraInitLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

export interface SemanticInfraInitOptions {
  log: SemanticInfraInitLogger;
  env?: NodeJS.ProcessEnv;
}

export interface SemanticInfraInitResult {
  vec0Loaded: boolean;
  vec0Version: string | null;
  profileRegistered: boolean;
  modelName: string | null;
  dim: number | null;
  /** Reason for skipping (if anything was skipped). For diagnostics. */
  skipReason?: string;
}

const DEFAULT_MODEL = "voyage-4-large";
const DEFAULT_DIM = 1024;

/** Known model → dim mappings to validate config consistency. */
const KNOWN_MODEL_DIMS: Record<string, number> = {
  "voyage-4-large": 1024,
  "voyage-3": 1024,
  "voyage-3-large": 1024,
  "voyage-3-lite": 512,
  "voyage-code-3": 1024,
};

/**
 * Try to initialize semantic infrastructure: load sqlite-vec, register
 * the active embedding profile, ensure the per-model vec0 table exists.
 *
 * Returns a snapshot of what happened. Caller (plugin init) logs the
 * relevant info; autostart's pre-flight checks then evaluate the result.
 *
 * Idempotent — safe to call on every plugin reload.
 */
export function initSemanticInfraIfPossible(
  db: DatabaseSync,
  opts: SemanticInfraInitOptions,
): SemanticInfraInitResult {
  const env = opts.env ?? process.env;
  const log = opts.log;

  if (env.LCM_DISABLE_SEMANTIC?.trim().toLowerCase() === "true") {
    log.info("[lcm] semantic infra: disabled via LCM_DISABLE_SEMANTIC=true");
    return {
      vec0Loaded: false,
      vec0Version: null,
      profileRegistered: false,
      modelName: null,
      dim: null,
      skipReason: "LCM_DISABLE_SEMANTIC=true",
    };
  }

  // Try to load sqlite-vec (best-effort)
  const loaded = tryLoadSqliteVec(db, { silent: true });
  const version = vec0Version(db);
  if (!loaded || version === null) {
    log.info(
      "[lcm] semantic infra: sqlite-vec extension not loaded; semantic retrieval will be unavailable. " +
        "Install via `pnpm add sqlite-vec` (or place vec0.dylib in ~/.openclaw/extensions/node_modules/sqlite-vec-darwin-arm64/) and restart.",
    );
    return {
      vec0Loaded: false,
      vec0Version: null,
      profileRegistered: false,
      modelName: null,
      dim: null,
      skipReason: "sqlite-vec not loadable",
    };
  }

  log.info(`[lcm] semantic infra: sqlite-vec loaded (version=${version})`);

  // Resolve model + dim from env
  const modelName = (env.LCM_EMBEDDING_MODEL?.trim() || DEFAULT_MODEL).trim();
  const dimRaw = env.LCM_EMBEDDING_DIM?.trim();
  let dim: number;
  if (dimRaw) {
    const parsed = Number.parseInt(dimRaw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      log.warn(
        `[lcm] semantic infra: LCM_EMBEDDING_DIM='${dimRaw}' is not a positive integer; falling back to known-model default for ${modelName}`,
      );
      dim = KNOWN_MODEL_DIMS[modelName] ?? DEFAULT_DIM;
    } else {
      dim = parsed;
    }
  } else {
    dim = KNOWN_MODEL_DIMS[modelName] ?? DEFAULT_DIM;
  }

  // Sanity check: if the model is known and dim doesn't match, warn
  // (don't block — operator may have a custom variant).
  const expectedDim = KNOWN_MODEL_DIMS[modelName];
  if (expectedDim !== undefined && expectedDim !== dim) {
    log.warn(
      `[lcm] semantic infra: dim=${dim} doesn't match known dim=${expectedDim} for ${modelName}; ` +
        `proceeding (operator may have a custom variant), but verify embedding output dim matches`,
    );
  }

  // Register profile (idempotent: throws on slug collision OR dim mismatch
  // for an existing profile).
  try {
    registerEmbeddingProfile(db, modelName, dim);
  } catch (e) {
    log.warn(
      `[lcm] semantic infra: profile registration failed: ${e instanceof Error ? e.message : String(e)}. ` +
        `Semantic retrieval will be unavailable until this is resolved.`,
    );
    return {
      vec0Loaded: true,
      vec0Version: version,
      profileRegistered: false,
      modelName,
      dim,
      skipReason: `profile registration failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // Ensure vec0 table + per-model triggers exist (idempotent)
  try {
    ensureEmbeddingsTable(db, modelName, dim);
  } catch (e) {
    log.warn(
      `[lcm] semantic infra: ensureEmbeddingsTable failed: ${e instanceof Error ? e.message : String(e)}. ` +
        `Profile is registered but the vec0 table couldn't be created — semantic backfill will fail.`,
    );
    return {
      vec0Loaded: true,
      vec0Version: version,
      profileRegistered: true,
      modelName,
      dim,
      skipReason: `ensureEmbeddingsTable failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  log.info(
    `[lcm] semantic infra: ready (model=${modelName} dim=${dim}). Backfill autostart will populate vec0 if VOYAGE_API_KEY is set.`,
  );
  return {
    vec0Loaded: true,
    vec0Version: version,
    profileRegistered: true,
    modelName,
    dim,
  };
}

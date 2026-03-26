import { createRequire } from "node:module";
import type { DbClient, RunResult } from "./db-interface.js";

// ── Minimal type declarations for node-postgres ────────────────────────────
// We define just enough structure to avoid `any` without depending on @types/pg.

interface PgQueryResult {
  rows: Record<string, unknown>[];
  rowCount: number | null;
}

interface PgPoolClient {
  query(sql: string, params?: unknown[]): Promise<PgQueryResult>;
  release(): void;
}

interface PgPool {
  query(sql: string, params?: unknown[]): Promise<PgQueryResult>;
  connect(): Promise<PgPoolClient>;
  end(): Promise<void>;
}

interface PgModule {
  Pool: new (config: {
    connectionString: string;
    min: number;
    max: number;
    idleTimeoutMillis: number;
  }) => PgPool;
}

// Lazy-loaded pg module — only resolved when PostgresClient is actually instantiated.
// This prevents "Cannot find module 'pg'" crashes on SQLite-only installs.
let _pg: PgModule | null = null;
function getPg(): PgModule {
  if (!_pg) {
    try {
      const require = createRequire(import.meta.url);
      _pg = require("pg") as PgModule;
    } catch {
      throw new Error(
        "PostgreSQL backend requires the 'pg' package. Install it with: npm install pg",
      );
    }
  }
  return _pg;
}

/**
 * Extract an integer ID from the first column of the first RETURNING row.
 * Callers write `INSERT ... RETURNING <id_col>`, so the first column is always the ID.
 */
function extractInsertId(rows: Record<string, unknown>[]): number | undefined {
  if (rows.length === 0 || typeof rows[0] !== "object" || rows[0] === null) {
    return undefined;
  }
  const vals = Object.values(rows[0]);
  if (vals.length === 0) return undefined;
  const v = vals[0];
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.length > 0 && !isNaN(Number(v))) return Number(v);
  return undefined;
}

/**
 * PostgreSQL implementation of the DbClient interface using node-postgres.
 *
 * Pool is created once per connection string (connection.ts caches the
 * PostgresClient instance, so we don't double-pool).
 */
export class PostgresClient implements DbClient {
  private pool: PgPool;

  constructor(connectionString: string) {
    const { Pool } = getPg();
    this.pool = new Pool({
      connectionString,
      min: 2,
      max: 10,
      idleTimeoutMillis: 30000,
    });
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    const result = await this.pool.query(sql, params);
    return { rows: result.rows as T[] };
  }

  async queryOne<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    const result = await this.pool.query(sql, params);
    return result.rows.length > 0 ? (result.rows[0] as T) : null;
  }

  async run(sql: string, params: unknown[] = []): Promise<RunResult> {
    const result = await this.pool.query(sql, params);
    return {
      rowCount: result.rowCount ?? 0,
      lastInsertId: extractInsertId(result.rows),
    };
  }

  async transaction<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
    const poolClient = await this.pool.connect();
    const txClient = new PostgresTransactionClient(poolClient);

    try {
      await poolClient.query("BEGIN");
      const result = await fn(txClient);
      await poolClient.query("COMMIT");
      return result;
    } catch (error) {
      await poolClient.query("ROLLBACK");
      throw error;
    } finally {
      poolClient.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Transaction-scoped PostgreSQL client that uses a single dedicated connection.
 */
class PostgresTransactionClient implements DbClient {
  constructor(private client: PgPoolClient) {}

  async query<T>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    const result = await this.client.query(sql, params);
    return { rows: result.rows as T[] };
  }

  async queryOne<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    const result = await this.client.query(sql, params);
    return result.rows.length > 0 ? (result.rows[0] as T) : null;
  }

  async run(sql: string, params: unknown[] = []): Promise<RunResult> {
    const result = await this.client.query(sql, params);
    return {
      rowCount: result.rowCount ?? 0,
      lastInsertId: extractInsertId(result.rows),
    };
  }

  async transaction<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
    // Nested transactions use savepoints
    const name = `sp_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    await this.client.query(`SAVEPOINT ${name}`);

    try {
      const result = await fn(this);
      await this.client.query(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (error) {
      await this.client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      throw error;
    }
  }

  async close(): Promise<void> {
    // Transaction clients don't own the connection — it's managed by the parent.
  }
}

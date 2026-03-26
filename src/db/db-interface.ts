/**
 * Database abstraction interface for supporting both SQLite and PostgreSQL
 */

export interface DbClient {
  /**
   * Execute a query and return all matching rows
   */
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;

  /**
   * Execute a query and return the first matching row, or null if none found
   */
  queryOne<T>(sql: string, params?: unknown[]): Promise<T | null>;

  /**
   * Execute a statement that doesn't return rows (INSERT, UPDATE, DELETE)
   * Returns affected row count and optionally the last inserted ID
   */
  run(sql: string, params?: unknown[]): Promise<{ rowCount: number; lastInsertId?: number }>;

  /**
   * Execute a function within a database transaction
   * Automatically commits on success, rolls back on error
   */
  transaction<T>(fn: (client: DbClient) => Promise<T>): Promise<T>;

  /**
   * Close the database connection
   */
  close(): Promise<void>;
}

export interface QueryResult<T> {
  rows: T[];
}

export interface RunResult {
  rowCount: number;
  lastInsertId?: number;
}
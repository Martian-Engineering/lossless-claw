/**
 * Thin SQL dialect adapter for SQLite ↔ PostgreSQL differences.
 *
 * Handles: parameter placeholders (?/$N), timestamp functions, and
 * small syntax gaps. NOT a query builder — just eliminates the
 * `if (this.backend === 'postgres')` branching from store code.
 */

export type Backend = "sqlite" | "postgres";

export class Dialect {
  private _paramCount = 0;

  constructor(readonly backend: Backend) {}

  /** Next parameter placeholder: `?` (SQLite) or `$N` (Postgres). */
  p(): string {
    return this.backend === "postgres" ? `$${++this._paramCount}` : "?";
  }

  /** Reset the parameter counter. Call at the start of each query. */
  reset(): this {
    this._paramCount = 0;
    return this;
  }

  /** Current parameter count (useful for manual indexing after auto params). */
  get paramCount(): number {
    return this._paramCount;
  }

  /** SQL expression for "current timestamp". */
  now(): string {
    return this.backend === "postgres" ? "NOW()" : "datetime('now')";
  }

  /** True when the backend is PostgreSQL. */
  get pg(): boolean {
    return this.backend === "postgres";
  }

  /**
   * Zero-padded integer-to-string expression.
   * Used in recursive CTEs for summary subtree path building.
   */
  zeroPad(expr: string, width: number): string {
    return this.backend === "postgres"
      ? `LPAD(${expr}::text, ${width}, '0')`
      : `printf('%0${width}d', ${expr})`;
  }

  /** COUNT(*)::int for Postgres (returns bigint otherwise), no-op for SQLite. */
  countInt(alias?: string): string {
    const cast = this.backend === "postgres" ? "COUNT(*)::int" : "COUNT(*)";
    return alias ? `${cast} AS ${alias}` : cast;
  }
}

import { describe, expect, it } from "vitest";
import { Dialect } from "../src/db/dialect.js";

describe("Dialect", () => {
  it("returns ? for SQLite placeholders", () => {
    const d = new Dialect("sqlite");
    expect(d.p()).toBe("?");
    expect(d.p()).toBe("?");
    expect(d.p()).toBe("?");
  });

  it("returns $N for PostgreSQL placeholders", () => {
    const d = new Dialect("postgres");
    expect(d.p()).toBe("$1");
    expect(d.p()).toBe("$2");
    expect(d.p()).toBe("$3");
  });

  it("resets counter", () => {
    const d = new Dialect("sqlite");
    d.p();
    d.p();
    expect(d.p()).toBe("?"); // 3rd
    d.reset();
    expect(d.p()).toBe("?"); // 1st again
  });

  it("provides backend-specific functions", () => {
    const sqlite = new Dialect("sqlite");
    expect(sqlite.now()).toBe("datetime('now')");
    expect(sqlite.countInt("total")).toBe("COUNT(*) AS total");

    const pg = new Dialect("postgres");
    expect(pg.now()).toBe("NOW()");
    expect(pg.countInt("total")).toBe("COUNT(*)::int AS total");
  });

  it("provides zeroPad for PostgreSQL", () => {
    const pg = new Dialect("postgres");
    expect(pg.zeroPad("ordinal", 4)).toBe("LPAD(ordinal::text, 4, '0')");

    const sqlite = new Dialect("sqlite");
    expect(sqlite.zeroPad("ordinal", 4)).toBe("printf('%04d', ordinal)"); // SQLite printf
  });
});
/**
 * Tests for getLcmDbFeatures — FTS5 probe and backend detection.
 *
 * Verifies the fix for the SQLite FTS5 regression where the missing
 * sqliteDb argument caused silent fallback to LIKE-based search.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getLcmDbFeatures } from "../src/db/features.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("getLcmDbFeatures", () => {
  it("returns fullTextAvailable=true for postgres backend", () => {
    const result = getLcmDbFeatures("postgres");
    expect(result.fullTextAvailable).toBe(true);
    expect(result.backend).toBe("postgres");
  });

  it("returns fullTextAvailable=false for sqlite without handle", () => {
    // This was the bug: calling without the sqliteDb argument
    const result = getLcmDbFeatures("sqlite");
    expect(result.fullTextAvailable).toBe(false);
    expect(result.backend).toBe("sqlite");
  });

  it("probes FTS5 correctly when given a SQLite handle", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-features-"));
    tempDirs.push(tempDir);
    const db = new DatabaseSync(join(tempDir, "test.db"));

    const result = getLcmDbFeatures("sqlite", db);
    // Node.js built-in sqlite includes FTS5
    expect(result.fullTextAvailable).toBe(true);
    expect(result.backend).toBe("sqlite");

    db.close();
  });

  it("caches FTS5 probe results per handle", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-features-cache-"));
    tempDirs.push(tempDir);
    const db = new DatabaseSync(join(tempDir, "test.db"));

    const result1 = getLcmDbFeatures("sqlite", db);
    const result2 = getLcmDbFeatures("sqlite", db);
    expect(result1).toBe(result2); // Same object reference (cached)

    db.close();
  });
});

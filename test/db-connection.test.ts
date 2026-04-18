import { describe, expect, it } from "vitest";
import {
  getFileBackedDatabasePath,
  isInMemoryPath,
  normalizePath,
} from "../src/db/connection.js";

describe("db connection path helpers", () => {
  it("treats non-string runtime values as non-memory paths", () => {
    expect(isInMemoryPath(123 as unknown as string)).toBe(false);
    expect(isInMemoryPath({} as unknown as string)).toBe(false);
  });

  it("returns null for non-string file-backed path inputs", () => {
    expect(getFileBackedDatabasePath(123 as unknown as string)).toBeNull();
    expect(getFileBackedDatabasePath({} as unknown as string)).toBeNull();
  });

  it("normalizes non-string runtime values to the in-memory connection key", () => {
    expect(normalizePath(123 as unknown as string)).toBe(":memory:");
    expect(normalizePath({} as unknown as string)).toBe(":memory:");
  });

  it("preserves file-backed paths for valid strings", () => {
    expect(getFileBackedDatabasePath(" ./tmp/lcm.db ")).toMatch(/tmp\/lcm\.db$/);
    expect(normalizePath(" ./tmp/lcm.db ")).toMatch(/tmp\/lcm\.db$/);
  });
});

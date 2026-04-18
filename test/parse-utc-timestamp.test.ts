import { describe, expect, it } from "vitest";
import { parseUtcTimestamp, parseUtcTimestampOrNull } from "../src/store/parse-utc-timestamp.js";

describe("parseUtcTimestamp", () => {
  it("treats bare SQLite timestamps as UTC", () => {
    expect(parseUtcTimestamp("2026-03-30 23:11:15").toISOString()).toBe(
      "2026-03-30T23:11:15.000Z",
    );
  });

  it("preserves explicit UTC suffixes", () => {
    expect(parseUtcTimestamp("2026-03-30T23:11:15Z").toISOString()).toBe(
      "2026-03-30T23:11:15.000Z",
    );
  });

  it("preserves explicit timezone offsets", () => {
    expect(parseUtcTimestamp("2026-03-30T23:11:15+02:00").toISOString()).toBe(
      "2026-03-30T21:11:15.000Z",
    );
  });

  it("returns an invalid date for non-string runtime values", () => {
    const parsed = parseUtcTimestamp(123 as unknown as string);
    expect(Number.isNaN(parsed.getTime())).toBe(true);
  });
});

describe("parseUtcTimestampOrNull", () => {
  it("returns null for nullish values", () => {
    expect(parseUtcTimestampOrNull(null)).toBeNull();
    expect(parseUtcTimestampOrNull(undefined)).toBeNull();
  });
});

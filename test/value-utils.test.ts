import { describe, expect, it } from "vitest";
import { resolve as resolvePath } from "node:path";
import {
  asRecord,
  formatDurationMs,
  getErrorCode,
  hashSerializedMessages,
  isMissingFileError,
  normalizeOptionalCount,
  normalizeSessionFilePathForComparison,
  resolvePositiveInteger,
  safeBoolean,
  safeString,
  toJson,
} from "../src/value-utils.js";

const nonErrorValues: Array<[string, unknown]> = [
  ["string", "ENOENT"],
  ["number", 42],
  ["null", null],
  ["undefined", undefined],
  ["plain object with code", { code: "ENOENT" }],
  ["plain object with message and code", { message: "boom", code: "EBUSY" }],
];

const nonStringValues: Array<[string, unknown]> = [
  ["number", 42],
  ["boolean", true],
  ["null", null],
  ["undefined", undefined],
  ["object", { key: "val" }],
  ["array", ["a", "b"]],
];

const nonBooleanValues: Array<[string, unknown]> = [
  ["string", "true"],
  ["number", 1],
  ["null", null],
  ["undefined", undefined],
  ["object", { value: true }],
];

const nonRecordValues: Array<[string, unknown]> = [
  ["array", [1, 2, 3]],
  ["null", null],
  ["undefined", undefined],
  ["string", "hello"],
  ["number", 42],
  ["boolean", true],
  ["function", () => undefined],
];

describe("getErrorCode", () => {
  it("returns the code when error has a string code", () => {
    const error = Object.assign(new Error("boom"), { code: "ENOENT" });
    expect(getErrorCode(error)).toBe("ENOENT");
  });

  it("returns undefined when error has no code property", () => {
    expect(getErrorCode(new Error("boom"))).toBeUndefined();
  });

  it("returns undefined when error code is not a string (numeric)", () => {
    const error = Object.assign(new Error("boom"), { code: 42 });
    expect(getErrorCode(error)).toBeUndefined();
  });

  it.each(nonErrorValues)("returns undefined for %s", (_label, value) => {
    expect(getErrorCode(value)).toBeUndefined();
  });
});

describe("isMissingFileError", () => {
  it.each(["ENOENT", "ENOTDIR"])("returns true for %s", (code) => {
    expect(isMissingFileError(Object.assign(new Error("gone"), { code }))).toBe(true);
  });

  it("returns false for other error codes", () => {
    expect(isMissingFileError(Object.assign(new Error("denied"), { code: "EACCES" }))).toBe(false);
    expect(isMissingFileError(Object.assign(new Error("busy"), { code: "EBUSY" }))).toBe(false);
  });

  it("returns false for Error without code", () => {
    expect(isMissingFileError(new Error("no code"))).toBe(false);
  });

  it.each(nonErrorValues)("returns false for %s", (_label, value) => {
    expect(isMissingFileError(value)).toBe(false);
  });
});

describe("normalizeSessionFilePathForComparison", () => {
  it.each([
    ["absolute path", "/foo/bar/session.jsonl", resolvePath("/foo/bar/session.jsonl")],
    ["trimmed absolute path", "  /foo/bar  ", resolvePath("/foo/bar")],
    ["relative path", "relative/path.jsonl", resolvePath("relative/path.jsonl")],
  ])("normalizes %s", (_label, input, expected) => {
    expect(normalizeSessionFilePathForComparison(input)).toBe(expected);
  });

  it.each(["", "   "])("returns empty string for empty input %j", (input) => {
    expect(normalizeSessionFilePathForComparison(input)).toBe("");
  });
});

describe("toJson", () => {
  it.each([
    ["plain object", { a: 1, b: "two" }, '{"a":1,"b":"two"}'],
    ["array", [1, 2, 3], "[1,2,3]"],
    ["string", "hello", '"hello"'],
    ["number", 42, "42"],
    ["boolean", true, "true"],
    ["null", null, "null"],
  ])("serializes %s to JSON", (_label, value, expected) => {
    expect(toJson(value)).toBe(expected);
  });

  it.each([
    ["undefined", undefined],
    ["function", () => undefined],
  ])("returns empty string when JSON.stringify omits %s", (_label, value) => {
    expect(toJson(value)).toBe("");
  });
});

describe("hashSerializedMessages", () => {
  it("returns a 16-character hex string", () => {
    const hash = hashSerializedMessages(["hello"]);
    expect(hash).toHaveLength(16);
    expect(/^[0-9a-f]{16}$/.test(hash)).toBe(true);
  });

  it("uses the expected truncated sha256 digest", () => {
    expect(hashSerializedMessages(["hello"])).toBe("c7a0f7154e64cd96");
  });

  it("produces deterministic output for the same input", () => {
    const a = hashSerializedMessages(["a", "b"]);
    const b = hashSerializedMessages(["a", "b"]);
    expect(a).toBe(b);
  });

  it("produces different output for different input", () => {
    const a = hashSerializedMessages(["a"]);
    const b = hashSerializedMessages(["b"]);
    expect(a).not.toBe(b);
  });

  it("handles an empty array", () => {
    const hash = hashSerializedMessages([]);
    expect(hash).toHaveLength(16);
  });

  it("preserves order sensitivity", () => {
    const forward = hashSerializedMessages(["first", "second"]);
    const reversed = hashSerializedMessages(["second", "first"]);
    expect(forward).not.toBe(reversed);
  });
});

describe("safeString", () => {
  it("returns the value when it is a string", () => {
    expect(safeString("hello")).toBe("hello");
  });

  it("returns empty string for an empty string", () => {
    expect(safeString("")).toBe("");
  });

  it.each(nonStringValues)("returns undefined for %s", (_label, value) => {
    expect(safeString(value)).toBeUndefined();
  });
});

describe("formatDurationMs", () => {
  it.each([
    [150, "150ms"],
    [0, "0ms"],
    [60000, "60000ms"],
    [-1, "-1ms"],
  ])("formats %s with the ms suffix", (durationMs, expected) => {
    expect(formatDurationMs(durationMs)).toBe(expected);
  });
});

describe("asRecord", () => {
  it("returns the object for a plain object", () => {
    const obj = { a: 1, b: 2 };
    expect(asRecord(obj)).toBe(obj);
  });

  it("returns the object for an empty object", () => {
    const obj = {};
    expect(asRecord(obj)).toBe(obj);
  });

  it.each(nonRecordValues)("returns undefined for %s", (_label, value) => {
    expect(asRecord(value)).toBeUndefined();
  });
});

describe("safeBoolean", () => {
  it("returns true for true", () => {
    expect(safeBoolean(true)).toBe(true);
  });

  it("returns false for false", () => {
    expect(safeBoolean(false)).toBe(false);
  });

  it.each(nonBooleanValues)("returns undefined for %s", (_label, value) => {
    expect(safeBoolean(value)).toBeUndefined();
  });
});

describe("resolvePositiveInteger", () => {
  const fallback = 100;

  it.each([
    [5, 5],
    [3.9, 3],
  ])("normalizes positive finite value %s", (value, expected) => {
    expect(resolvePositiveInteger(value, fallback)).toBe(expected);
  });

  it.each([
    ["zero", 0],
    ["negative number", -5],
    ["Infinity", Infinity],
    ["-Infinity", -Infinity],
    ["NaN", NaN],
    ["string", "5"],
    ["null", null],
    ["undefined", undefined],
    ["boolean", true],
  ])("returns the fallback for %s", (_label, value) => {
    expect(resolvePositiveInteger(value, fallback)).toBe(fallback);
  });
});

describe("normalizeOptionalCount", () => {
  it.each([
    [5, 5],
    [3.9, 3],
    [0, 0],
  ])("normalizes non-negative finite value %s", (value, expected) => {
    expect(normalizeOptionalCount(value)).toBe(expected);
  });

  it.each([
    ["negative number", -1],
    ["Infinity", Infinity],
    ["-Infinity", -Infinity],
    ["NaN", NaN],
    ["string", "5"],
    ["null", null],
    ["undefined", undefined],
    ["boolean", false],
  ])("returns undefined for %s", (_label, value) => {
    expect(normalizeOptionalCount(value)).toBeUndefined();
  });
});

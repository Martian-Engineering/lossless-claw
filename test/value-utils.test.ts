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

// ---------------------------------------------------------------------------
// getErrorCode
// ---------------------------------------------------------------------------
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

  it("returns undefined for non-Error values", () => {
    expect(getErrorCode("ENOENT")).toBeUndefined();
    expect(getErrorCode(42)).toBeUndefined();
    expect(getErrorCode(null)).toBeUndefined();
    expect(getErrorCode(undefined)).toBeUndefined();
    expect(getErrorCode({ code: "ENOENT" })).toBeUndefined();
  });

  it("returns undefined for a plain object with message + code (not an Error instance)", () => {
    expect(getErrorCode({ message: "boom", code: "EBUSY" })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// isMissingFileError
// ---------------------------------------------------------------------------
describe("isMissingFileError", () => {
  it("returns true for ENOENT", () => {
    expect(isMissingFileError(Object.assign(new Error("gone"), { code: "ENOENT" }))).toBe(true);
  });

  it("returns true for ENOTDIR", () => {
    expect(isMissingFileError(Object.assign(new Error("not a dir"), { code: "ENOTDIR" }))).toBe(
      true,
    );
  });

  it("returns false for other error codes", () => {
    expect(isMissingFileError(Object.assign(new Error("denied"), { code: "EACCES" }))).toBe(false);
    expect(isMissingFileError(Object.assign(new Error("busy"), { code: "EBUSY" }))).toBe(false);
  });

  it("returns false for Error without code", () => {
    expect(isMissingFileError(new Error("no code"))).toBe(false);
  });

  it("returns false for non-Error values", () => {
    expect(isMissingFileError("ENOENT")).toBe(false);
    expect(isMissingFileError({ code: "ENOENT" })).toBe(false);
    expect(isMissingFileError(null)).toBe(false);
    expect(isMissingFileError(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// normalizeSessionFilePathForComparison
// ---------------------------------------------------------------------------
describe("normalizeSessionFilePathForComparison", () => {
  it("resolves a valid path to an absolute path", () => {
    const result = normalizeSessionFilePathForComparison("/foo/bar/session.jsonl");
    expect(result).toBe(resolvePath("/foo/bar/session.jsonl"));
  });

  it("trims whitespace before resolving", () => {
    const result = normalizeSessionFilePathForComparison("  /foo/bar  ");
    expect(result).toBe(resolvePath("/foo/bar"));
  });

  it("returns empty string for empty input", () => {
    expect(normalizeSessionFilePathForComparison("")).toBe("");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(normalizeSessionFilePathForComparison("   ")).toBe("");
  });

  it("resolves a relative path against cwd", () => {
    const result = normalizeSessionFilePathForComparison("relative/path.jsonl");
    expect(result).toBe(resolvePath("relative/path.jsonl"));
  });
});

// ---------------------------------------------------------------------------
// toJson
// ---------------------------------------------------------------------------
describe("toJson", () => {
  it("serializes a plain object to JSON", () => {
    expect(toJson({ a: 1, b: "two" })).toBe('{"a":1,"b":"two"}');
  });

  it("serializes an array to JSON", () => {
    expect(toJson([1, 2, 3])).toBe("[1,2,3]");
  });

  it("serializes a string (produces a quoted JSON string)", () => {
    expect(toJson("hello")).toBe('"hello"');
  });

  it("serializes a number", () => {
    expect(toJson(42)).toBe("42");
  });

  it("serializes a boolean", () => {
    expect(toJson(true)).toBe("true");
  });

  it("serializes null", () => {
    expect(toJson(null)).toBe("null");
  });

  it("returns empty string for undefined (JSON.stringify returns undefined, not a string)", () => {
    expect(toJson(undefined)).toBe("");
  });

  it("returns empty string for a function (JSON.stringify returns undefined)", () => {
    expect(toJson(() => {})).toBe("");
  });
});

// ---------------------------------------------------------------------------
// hashSerializedMessages
// ---------------------------------------------------------------------------
describe("hashSerializedMessages", () => {
  it("returns a 16-character hex string", () => {
    const hash = hashSerializedMessages(["hello"]);
    expect(hash).toHaveLength(16);
    expect(/^[0-9a-f]{16}$/.test(hash)).toBe(true);
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

  it("preserves order sensitivity (different order → different hash)", () => {
    const forward = hashSerializedMessages(["first", "second"]);
    const reversed = hashSerializedMessages(["second", "first"]);
    expect(forward).not.toBe(reversed);
  });
});

// ---------------------------------------------------------------------------
// safeString
// ---------------------------------------------------------------------------
describe("safeString", () => {
  it("returns the value when it is a string", () => {
    expect(safeString("hello")).toBe("hello");
  });

  it("returns empty string for an empty string", () => {
    expect(safeString("")).toBe("");
  });

  it("returns undefined for a number", () => {
    expect(safeString(42)).toBeUndefined();
  });

  it("returns undefined for a boolean", () => {
    expect(safeString(true)).toBeUndefined();
  });

  it("returns undefined for null", () => {
    expect(safeString(null)).toBeUndefined();
  });

  it("returns undefined for undefined", () => {
    expect(safeString(undefined)).toBeUndefined();
  });

  it("returns undefined for an object", () => {
    expect(safeString({ key: "val" })).toBeUndefined();
  });

  it("returns undefined for an array", () => {
    expect(safeString(["a", "b"])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// formatDurationMs
// ---------------------------------------------------------------------------
describe("formatDurationMs", () => {
  it("formats a duration with the ms suffix", () => {
    expect(formatDurationMs(150)).toBe("150ms");
  });

  it("formats zero", () => {
    expect(formatDurationMs(0)).toBe("0ms");
  });

  it("formats a large duration", () => {
    expect(formatDurationMs(60000)).toBe("60000ms");
  });

  it("formats a negative number (passes through as-is)", () => {
    expect(formatDurationMs(-1)).toBe("-1ms");
  });
});

// ---------------------------------------------------------------------------
// asRecord
// ---------------------------------------------------------------------------
describe("asRecord", () => {
  it("returns the object for a plain object", () => {
    const obj = { a: 1, b: 2 };
    expect(asRecord(obj)).toBe(obj);
  });

  it("returns the object for an empty object", () => {
    const obj = {};
    expect(asRecord(obj)).toBe(obj);
  });

  it("returns undefined for an array", () => {
    expect(asRecord([1, 2, 3])).toBeUndefined();
  });

  it("returns undefined for null", () => {
    expect(asRecord(null)).toBeUndefined();
  });

  it("returns undefined for undefined", () => {
    expect(asRecord(undefined)).toBeUndefined();
  });

  it("returns undefined for a string", () => {
    expect(asRecord("hello")).toBeUndefined();
  });

  it("returns undefined for a number", () => {
    expect(asRecord(42)).toBeUndefined();
  });

  it("returns undefined for a boolean", () => {
    expect(asRecord(true)).toBeUndefined();
  });

  it("returns undefined for a function", () => {
    expect(asRecord(() => {})).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// safeBoolean
// ---------------------------------------------------------------------------
describe("safeBoolean", () => {
  it("returns true for true", () => {
    expect(safeBoolean(true)).toBe(true);
  });

  it("returns false for false", () => {
    expect(safeBoolean(false)).toBe(false);
  });

  it("returns undefined for a string", () => {
    expect(safeBoolean("true")).toBeUndefined();
  });

  it("returns undefined for a number", () => {
    expect(safeBoolean(1)).toBeUndefined();
  });

  it("returns undefined for null", () => {
    expect(safeBoolean(null)).toBeUndefined();
  });

  it("returns undefined for undefined", () => {
    expect(safeBoolean(undefined)).toBeUndefined();
  });

  it("returns undefined for an object", () => {
    expect(safeBoolean({ value: true })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolvePositiveInteger
// ---------------------------------------------------------------------------
describe("resolvePositiveInteger", () => {
  const fallback = 100;

  it("returns the floored integer for a positive finite number", () => {
    expect(resolvePositiveInteger(5, fallback)).toBe(5);
  });

  it("floors floating point values", () => {
    expect(resolvePositiveInteger(3.9, fallback)).toBe(3);
  });

  it("returns the fallback for zero", () => {
    expect(resolvePositiveInteger(0, fallback)).toBe(fallback);
  });

  it("returns the fallback for a negative number", () => {
    expect(resolvePositiveInteger(-5, fallback)).toBe(fallback);
  });

  it("returns the fallback for Infinity", () => {
    expect(resolvePositiveInteger(Infinity, fallback)).toBe(fallback);
  });

  it("returns the fallback for -Infinity", () => {
    expect(resolvePositiveInteger(-Infinity, fallback)).toBe(fallback);
  });

  it("returns the fallback for NaN", () => {
    expect(resolvePositiveInteger(NaN, fallback)).toBe(fallback);
  });

  it("returns the fallback for a string", () => {
    expect(resolvePositiveInteger("5", fallback)).toBe(fallback);
  });

  it("returns the fallback for null", () => {
    expect(resolvePositiveInteger(null, fallback)).toBe(fallback);
  });

  it("returns the fallback for undefined", () => {
    expect(resolvePositiveInteger(undefined, fallback)).toBe(fallback);
  });

  it("returns the fallback for a boolean", () => {
    expect(resolvePositiveInteger(true, fallback)).toBe(fallback);
  });
});

// ---------------------------------------------------------------------------
// normalizeOptionalCount
// ---------------------------------------------------------------------------
describe("normalizeOptionalCount", () => {
  it("returns the floored integer for a non-negative finite number", () => {
    expect(normalizeOptionalCount(5)).toBe(5);
  });

  it("floors floating point values", () => {
    expect(normalizeOptionalCount(3.9)).toBe(3);
  });

  it("returns 0 for zero", () => {
    expect(normalizeOptionalCount(0)).toBe(0);
  });

  it("returns undefined for a negative number", () => {
    expect(normalizeOptionalCount(-1)).toBeUndefined();
  });

  it("returns undefined for Infinity", () => {
    expect(normalizeOptionalCount(Infinity)).toBeUndefined();
  });

  it("returns undefined for -Infinity", () => {
    expect(normalizeOptionalCount(-Infinity)).toBeUndefined();
  });

  it("returns undefined for NaN", () => {
    expect(normalizeOptionalCount(NaN)).toBeUndefined();
  });

  it("returns undefined for a string", () => {
    expect(normalizeOptionalCount("5")).toBeUndefined();
  });

  it("returns undefined for null", () => {
    expect(normalizeOptionalCount(null)).toBeUndefined();
  });

  it("returns undefined for undefined", () => {
    expect(normalizeOptionalCount(undefined)).toBeUndefined();
  });

  it("returns undefined for a boolean", () => {
    expect(normalizeOptionalCount(false)).toBeUndefined();
  });
});

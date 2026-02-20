import { describe, it, expect } from "vitest";
import { sanitizeFts5Query } from "../src/store/fts5-sanitize.js";

describe("sanitizeFts5Query", () => {
  it("quotes simple tokens", () => {
    expect(sanitizeFts5Query("hello world")).toBe('"hello" "world"');
  });

  it("preserves hyphens inside quotes", () => {
    expect(sanitizeFts5Query("sub-agent restrict")).toBe('"sub-agent" "restrict"');
  });

  it("neutralizes boolean operators", () => {
    expect(sanitizeFts5Query("lcm_expand OR crash")).toBe('"lcm_expand" "OR" "crash"');
  });

  it("strips internal double quotes", () => {
    expect(sanitizeFts5Query('hello "world"')).toBe('"hello" "world"');
  });

  it("handles colons (column filter syntax)", () => {
    expect(sanitizeFts5Query("agent:foo bar")).toBe('"agent:foo" "bar"');
  });

  it("handles prefix star operator", () => {
    expect(sanitizeFts5Query("lcm*")).toBe('"lcm*"');
  });

  it("handles empty string", () => {
    expect(sanitizeFts5Query("")).toBe('""');
  });

  it("handles whitespace-only", () => {
    expect(sanitizeFts5Query("   ")).toBe('""');
  });

  it("handles single token", () => {
    expect(sanitizeFts5Query("expand")).toBe('"expand"');
  });

  it("collapses multiple spaces", () => {
    expect(sanitizeFts5Query("a   b   c")).toBe('"a" "b" "c"');
  });

  it("handles NOT operator", () => {
    expect(sanitizeFts5Query("NOT agent")).toBe('"NOT" "agent"');
  });

  it("handles NEAR operator", () => {
    expect(sanitizeFts5Query("NEAR(a b)")).toBe('"NEAR(a" "b)"');
  });

  it("handles caret (initial token)", () => {
    expect(sanitizeFts5Query("^start")).toBe('"^start"');
  });
});

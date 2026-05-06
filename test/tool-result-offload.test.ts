import { describe, expect, it } from "vitest";
import {
  buildToolResultPreviewText,
  sanitizeToolResultDetails,
} from "../src/tool-result-offload.js";

describe("tool-result offload helpers", () => {
  it("builds a deterministic preview that includes the file id", () => {
    const preview = buildToolResultPreviewText({
      fileId: "file_deadbeefcafefeed",
      toolName: "exec",
      originalByteSize: 12_345,
      isError: false,
      originalText: `head section ${"A".repeat(2000)} tail section`,
      previewChars: 120,
    });

    expect(preview).toContain("file_deadbeefcafefeed");
    expect(preview).toContain("exec");
    expect(preview).toContain("12,345 bytes");
    expect(preview).toContain("Full output stored as file_deadbeefcafefeed.");
    expect(preview).toContain("tail section");
    expect(preview).toContain("...");
  });

  it("sanitizes exec details while preserving small execution metadata", () => {
    const sanitized = sanitizeToolResultDetails({
      toolName: "exec",
      details: {
        status: "completed",
        exitCode: 0,
        durationMs: 321,
        cwd: "/tmp/project",
        aggregated: "x".repeat(20_000),
      },
      meta: {
        fileId: "file_deadbeefcafefeed",
        originalChars: 20_000,
        originalBytes: 20_100,
        previewChars: 1800,
        strategy: "deterministic_head_tail",
      },
    });

    expect(sanitized).toMatchObject({
      status: "completed",
      exitCode: 0,
      durationMs: 321,
      cwd: "/tmp/project",
      lcmOffload: {
        fileId: "file_deadbeefcafefeed",
        originalChars: 20_000,
        originalBytes: 20_100,
        previewChars: 1800,
        strategy: "deterministic_head_tail",
      },
    });
    expect("aggregated" in sanitized).toBe(false);
  });

  it("reduces generic nested details to small summaries", () => {
    const sanitized = sanitizeToolResultDetails({
      toolName: "web_search",
      details: {
        provider: "serp",
        tookMs: 80,
        results: [{ title: "one" }, { title: "two" }],
        extra: { raw: "payload", more: true },
        snippet: "y".repeat(1000),
      },
      meta: {
        fileId: "file_deadbeefcafef00d",
        originalChars: 4000,
        originalBytes: 4100,
        previewChars: 900,
        strategy: "deterministic_head_tail",
      },
    });

    expect(sanitized).toMatchObject({
      provider: "serp",
      tookMs: 80,
      results: { count: 2 },
      extra: { keys: 2 },
      lcmOffload: {
        fileId: "file_deadbeefcafef00d",
      },
    });
    expect("snippet" in sanitized).toBe(false);
  });

  it("keeps canonical lcmOffload metadata when generic details already contain lcmOffload", () => {
    const sanitized = sanitizeToolResultDetails({
      toolName: "web_search",
      details: {
        lcmOffload: {
          fileId: "file_oldoldoldoldold",
          stale: true,
        },
        provider: "serp",
        extra: { raw: "payload", more: true },
      },
      meta: {
        fileId: "file_deadbeefcafef00d",
        originalChars: 4000,
        originalBytes: 4100,
        previewChars: 900,
        strategy: "deterministic_head_tail",
      },
    });

    expect(sanitized).toMatchObject({
      provider: "serp",
      extra: { keys: 2 },
      lcmOffload: {
        fileId: "file_deadbeefcafef00d",
        originalChars: 4000,
        originalBytes: 4100,
        previewChars: 900,
        strategy: "deterministic_head_tail",
      },
    });
  });
});

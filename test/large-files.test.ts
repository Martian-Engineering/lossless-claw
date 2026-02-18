import { describe, expect, it, vi } from "vitest";
import {
  extensionFromNameOrMime,
  extractFileIdsFromContent,
  formatFileReference,
  generateExplorationSummary,
  parseFileBlocks,
} from "./large-files.js";

describe("large-files parseFileBlocks", () => {
  it("parses multiple <file> blocks and attributes", () => {
    const content = [
      'Before <file name="a.json" mime="application/json">{"a":1}</file>',
      "Middle",
      "<file name='notes.md'># Title\nBody</file>",
      "After",
    ].join("\n");

    const blocks = parseFileBlocks(content);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].fileName).toBe("a.json");
    expect(blocks[0].mimeType).toBe("application/json");
    expect(blocks[0].text).toBe('{"a":1}');
    expect(blocks[1].fileName).toBe("notes.md");
    expect(blocks[1].mimeType).toBeUndefined();
    expect(blocks[1].text).toContain("# Title");
  });
});

describe("large-files helpers", () => {
  it("formats compact file references", () => {
    const text = formatFileReference({
      fileId: "file_aaaaaaaaaaaaaaaa",
      fileName: "paper.pdf",
      mimeType: "application/pdf",
      byteSize: 42150,
      summary: "A concise summary.",
    });

    expect(text).toContain(
      "[LCM File: file_aaaaaaaaaaaaaaaa | paper.pdf | application/pdf | 42,150 bytes]",
    );
    expect(text).toContain("Exploration Summary:");
    expect(text).toContain("A concise summary.");
  });

  it("resolves extensions from name or mime", () => {
    expect(extensionFromNameOrMime("report.csv", "text/plain")).toBe("csv");
    expect(extensionFromNameOrMime(undefined, "application/json")).toBe("json");
    expect(extensionFromNameOrMime(undefined, undefined)).toBe("txt");
  });

  it("extracts file ids in order without duplicates", () => {
    const ids = extractFileIdsFromContent(
      "See file_aaaaaaaaaaaaaaaa and file_bbbbbbbbbbbbbbbb then file_aaaaaaaaaaaaaaaa again.",
    );

    expect(ids).toEqual(["file_aaaaaaaaaaaaaaaa", "file_bbbbbbbbbbbbbbbb"]);
  });
});

describe("large-files exploration summaries", () => {
  it("uses deterministic structured summary for JSON", async () => {
    const summary = await generateExplorationSummary({
      content: JSON.stringify({ users: [{ id: 1, email: "a@example.com" }], count: 1 }),
      fileName: "data.json",
      mimeType: "application/json",
      summarizeText: vi.fn(),
    });

    expect(summary).toContain("Structured summary (JSON)");
    expect(summary).toContain("Top-level type");
  });

  it("uses deterministic code summary for code files", async () => {
    const summary = await generateExplorationSummary({
      content: [
        "import { readFileSync } from 'node:fs';",
        "export function runTask(input: string) {",
        "  return input.trim();",
        "}",
      ].join("\n"),
      fileName: "task.ts",
      mimeType: "text/x-typescript",
      summarizeText: vi.fn(),
    });

    expect(summary).toContain("Code exploration summary");
    expect(summary).toContain("Imports/dependencies");
    expect(summary).toContain("Top-level definitions");
  });

  it("uses model summary hook for text files when available", async () => {
    const summarizeText = vi.fn(async () => "Model-produced exploration summary.");
    const summary = await generateExplorationSummary({
      content: "This is a very long plain-text report.".repeat(500),
      fileName: "report.txt",
      mimeType: "text/plain",
      summarizeText,
    });

    expect(summarizeText).toHaveBeenCalledTimes(1);
    expect(summary).toBe("Model-produced exploration summary.");
  });

  it("falls back to deterministic text summary when model summary fails", async () => {
    const summarizeText = vi.fn(async () => {
      throw new Error("model unavailable");
    });
    const summary = await generateExplorationSummary({
      content: ["# Overview", "SYSTEM STATUS", "All systems nominal."].join("\n\n"),
      fileName: "status.txt",
      mimeType: "text/plain",
      summarizeText,
    });

    expect(summary).toContain("Text exploration summary");
    expect(summary).toContain("Detected section headers");
  });
});

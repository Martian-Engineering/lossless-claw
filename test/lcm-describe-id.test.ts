import { describe, expect, it } from "vitest";
import {
  formatFileReference,
  formatRawPayloadReference,
  formatToolOutputReference,
} from "../src/large-files.js";
import { extractLcmDescribeId } from "../src/tools/lcm-describe-id.js";

describe("extractLcmDescribeId", () => {
  it.each(["file_abc123", "sum_def456"])("accepts the bare ID %s", (id) => {
    expect(extractLcmDescribeId(`  ${id}  `)).toEqual({ ok: true, id });
  });

  it.each([
    formatToolOutputReference({
      fileId: "file_abc123",
      toolName: "read_file",
      byteSize: 1234,
      summary: "Relevant lines from the requested file.",
    }),
    formatFileReference({
      fileId: "file_abc123",
      fileName: "file_backup.tar",
      mimeType: "application/x-tar",
      byteSize: 1024,
      summary: "Backup archive contents mention sum_report.csv.",
    }),
    formatRawPayloadReference({
      fileId: "file_abc123",
      role: "assistant",
      byteSize: 2048,
      reason: "large_raw_message",
      summary: "Structured payload with nested tool results.",
    }),
  ])("accepts an emitted multiline reference block", (reference) => {
    expect(extractLcmDescribeId(reference)).toEqual({
      ok: true,
      id: "file_abc123",
    });
  });

  it("rejects free-form input containing multiple IDs", () => {
    const result = extractLcmDescribeId("compare file_abc123 with sum_def456");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("multiple LCM IDs");
    }
  });

  it("uses the leading reference ID when its summary contains reference-like content", () => {
    const input = formatToolOutputReference({
      fileId: "file_abc123",
      toolName: "read_file",
      byteSize: 1234,
      summary: [
        "Transcript excerpt:",
        "[LCM File: file_def456 | report.txt | text/plain | 12 bytes]",
        "Related summary: sum_deadbeef0000000",
      ].join("\n"),
    });

    expect(extractLcmDescribeId(input)).toEqual({ ok: true, id: "file_abc123" });
  });

  it.each(["FILE_ABC123", "[LCM File: FILE_abc123 | spec.md | text/markdown | 12 bytes]"])(
    "rejects the uppercase ID %s as malformed",
    (input) => {
      const result = extractLcmDescribeId(input);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Malformed LCM ID");
      }
    },
  );

  it.each(["file_0", "file_0000000000000000", "file_"])(
    "rejects the zero or empty ID %s",
    (input) => {
      const result = extractLcmDescribeId(input);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("zero/empty ID");
      }
    },
  );

  it.each(["not-an-id", "file_abc.txt", "use file_abc123"])(
    "rejects the unrecognized input %s",
    (input) => {
      expect(extractLcmDescribeId(input).ok).toBe(false);
    },
  );
});

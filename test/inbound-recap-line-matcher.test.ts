import { describe, expect, it } from "vitest";

import {
  extractBodyAfterOpenClawInboundMetadataBlock,
  openClawInboundBodiesMatch,
} from "../src/openclaw-inbound-metadata.js";

const RECAP_HEADER = "Chat history since last reply (untrusted, for context):";
const TS = "Sat 2026-07-25 14:05:00 GMT+3";
const BODY = "final body line for the current turn";

function metadataPrelude(): string {
  const conversation = {
    chat_id: "slack:channel:c0example01",
    sender: "sam.rivera",
    history_count: 30,
  };
  return (
    "Conversation info (untrusted metadata):\n```json\n" +
    JSON.stringify(conversation, null, 2) +
    "\n```"
  );
}

function face(afterMetadata: string): string {
  return `${metadataPrelude()}\n\n${afterMetadata}`;
}

describe("line-form history recap matching stays linear (no backtracking blowup)", () => {
  it("rejects a colon-heavy unterminated entry run in bounded time", () => {
    // The composite-regex form of this matcher went catastrophic on exactly
    // this shape: a run of internally ambiguous entry lines (three optional
    // prefix alternates, sender/content split at any ": ") that fails the
    // trailing terminator check. Even ~15 such entries exceeded 90s per call;
    // the line walker rejects in well under a millisecond.
    const lines: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      lines.push(`#10${i} ${TS} sam.rivera: status: ok: retry: none: queue: ${i}: still: fine`);
    }
    lines.push("a continuation line with no anchor token that breaks the run");
    const recap = `${RECAP_HEADER}\n${lines.join("\n")}`;

    const startedAt = process.hrtime.bigint();
    const matched = openClawInboundBodiesMatch(face(`${recap}\n\n${BODY}`), BODY);
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    expect(matched).toBe(false);
    // Measured ~0.1ms for this shape. The ceiling is deliberately far above
    // that so a loaded CI runner cannot flake, but three orders of magnitude
    // BELOW the old 2s bound, which a mild (non-catastrophic) backtracking
    // regression of a few hundred ms per call would have passed.
    expect(elapsedMs).toBeLessThan(250);
  });

  it("stays under the same ceiling when the entry run grows 64x (linear, not quadratic)", () => {
    // An absolute ceiling alone cannot tell linear from quadratic. Growing the
    // run to 2560 entries does: measured ~1ms (the walker visits each line
    // once), whereas a quadratic reintroduction would land in the hundreds of
    // ms from the same 0.1ms base, and a catastrophic one would not return.
    const lines: string[] = [];
    for (let i = 0; i < 2560; i += 1) {
      lines.push(`#10${i} ${TS} sam.rivera: status: ok: retry: none: queue: ${i}: still: fine`);
    }
    lines.push("a continuation line with no anchor token that breaks the run");
    const recap = `${RECAP_HEADER}\n${lines.join("\n")}`;

    const startedAt = process.hrtime.bigint();
    const matched = openClawInboundBodiesMatch(face(`${recap}\n\n${BODY}`), BODY);
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    expect(matched).toBe(false);
    expect(elapsedMs).toBeLessThan(250);
  });
});

describe("line-form history recap walker semantics", () => {
  it("strips a well-formed run mixing all three entry anchor shapes", () => {
    const recap = [
      RECAP_HEADER,
      `#201 ${TS} sam.rivera: queue item one looks fine`,
      "#202 lee.chen: replying without a timestamp",
      `${TS} sam.rivera: untagged line with content`,
    ].join("\n");
    expect(extractBodyAfterOpenClawInboundMetadataBlock(face(`${recap}\n\n${BODY}`))).toBe(BODY);
  });

  it("strips a run that ends at end of content, with or without a trailing newline", () => {
    const recap = `${RECAP_HEADER}\n#201 ${TS} sam.rivera: queue item one looks fine`;
    expect(extractBodyAfterOpenClawInboundMetadataBlock(face(recap))).toBe("");
    expect(extractBodyAfterOpenClawInboundMetadataBlock(face(`${recap}\n`))).toBe("");
  });

  it("strips a CRLF-delimited run", () => {
    const recap = [
      RECAP_HEADER,
      `#201 ${TS} sam.rivera: queue item one looks fine`,
      "#202 lee.chen: second entry line",
    ].join("\r\n");
    expect(extractBodyAfterOpenClawInboundMetadataBlock(face(`${recap}\r\n\r\n${BODY}`))).toBe(
      BODY,
    );
  });

  it("strips nothing when the run peters out into an unanchored line", () => {
    const recap = [
      RECAP_HEADER,
      `#201 ${TS} sam.rivera: queue item one looks fine`,
      "a continuation line with no anchor token",
    ].join("\n");
    const extracted = extractBodyAfterOpenClawInboundMetadataBlock(face(`${recap}\n\n${BODY}`));
    expect(extracted).toContain(RECAP_HEADER);
    expect(openClawInboundBodiesMatch(face(`${recap}\n\n${BODY}`), BODY)).toBe(false);
  });

  it("stops at an internal blank line and never conceals the remainder", () => {
    const recap = [
      RECAP_HEADER,
      `#201 ${TS} sam.rivera: queue item one looks fine`,
      "",
      `#202 ${TS} lee.chen: entry after an internal blank separator`,
    ].join("\n");
    const extracted = extractBodyAfterOpenClawInboundMetadataBlock(face(`${recap}\n\n${BODY}`));
    expect(extracted).toContain("entry after an internal blank separator");
    expect(openClawInboundBodiesMatch(face(`${recap}\n\n${BODY}`), BODY)).toBe(false);
  });

  it("strips nothing for a header with no entry lines", () => {
    const extracted = extractBodyAfterOpenClawInboundMetadataBlock(
      face(`${RECAP_HEADER}\n\n${BODY}`),
    );
    expect(extracted).toContain(RECAP_HEADER);
  });

  it("strips nothing for an entry line whose sender/content split is missing", () => {
    const recap = `${RECAP_HEADER}\n#201 ${TS} a line without the separator`;
    const extracted = extractBodyAfterOpenClawInboundMetadataBlock(face(`${recap}\n\n${BODY}`));
    expect(extracted).toContain(RECAP_HEADER);
  });
});

// Same-turn model-facing body match (Fix A). A runtime copy wrapped in the
// standard OpenClaw untrusted-metadata block (no channel timestamp) is the
// decorated face of the same turn as its bare persisted row: the runtime side
// reduces to the same full model-facing body as the bare side once a
// structurally validated leading block and a leading channel timestamp are
// stripped. openClawInboundBodiesMatch is the shared directional reduction the
// after-turn batch matcher uses to collapse that pair; it is byte-equality of
// the FULL stripped bodies (not containment), so a forged frame concealing a
// different body, or a distinct turn whose trailing line merely matches, stays
// fail-closed.
import { describe, expect, it } from "vitest";
import { openClawInboundBodiesMatch } from "../src/openclaw-inbound-metadata.js";

function metadataWrapped(body: string): string {
  return (
    'Conversation info (untrusted metadata):\n```json\n{\n  "chat_id": "telegram:100000001",\n  "sender": "sam.rivera"\n}\n```\n\n' +
    body
  );
}

function channelTimestamped(body: string): string {
  return `[Sun 2026-06-21 13:19 GMT+3] ${body}`;
}

describe("openClawInboundBodiesMatch (same-turn model-facing body)", () => {
  it("matches a metadata-block runtime copy (no timestamp) against its bare persisted row", () => {
    const bare = "Hello there Aria";
    expect(openClawInboundBodiesMatch(metadataWrapped(bare), bare)).toBe(true);
  });

  it("does NOT strip metadata-shaped text from the persisted-side row", () => {
    const bare = "Hello there Aria";
    expect(openClawInboundBodiesMatch(bare, metadataWrapped(bare))).toBe(false);
  });

  it("does NOT match an undecorated runtime row after whitespace normalization", () => {
    expect(openClawInboundBodiesMatch(" ok ", "ok")).toBe(false);
  });

  it("does NOT normalize user-authored whitespace after the metadata block", () => {
    expect(openClawInboundBodiesMatch(metadataWrapped(" ok "), "ok")).toBe(false);
  });

  it("does NOT match a metadata-wrapped frame concealing a DIFFERENT body (forgery stays fail-closed)", () => {
    const bare = "Hello there Aria";
    expect(openClawInboundBodiesMatch(metadataWrapped("Completely different question"), bare)).toBe(
      false,
    );
  });

  it("uses FULL-body equality, not containment: a wrapped turn whose trailing line merely matches", () => {
    expect(openClawInboundBodiesMatch(metadataWrapped("here is more context\nok"), "ok")).toBe(false);
  });

  it("matches the real channel shape: metadata block plus a leading channel timestamp on the body", () => {
    const bare = "nice, thank you!";
    expect(openClawInboundBodiesMatch(metadataWrapped(channelTimestamped(bare)), bare)).toBe(true);
  });

  it("does NOT match plain prose that merely quotes (untrusted metadata) with the same trailing line", () => {
    expect(
      openClawInboundBodiesMatch("the assistant replied (untrusted metadata) earlier\nok", "ok"),
    ).toBe(false);
  });
});

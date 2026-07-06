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
import {
  canonicalizeOpenClawInboundMetadataIdentityContent,
  openClawInboundBodiesMatch,
  openClawInboundModelFacingBody,
} from "../src/openclaw-inbound-metadata.js";
import { buildMessageIdentityHash } from "../src/store/message-identity.js";

function metadataWrapped(body: string): string {
  return (
    'Conversation info (untrusted metadata):\n```json\n{\n  "chat_id": "telegram:100000001",\n  "sender": "sam.rivera"\n}\n```\n\n' +
    body
  );
}

function channelTimestamped(body: string): string {
  return `[Sun 2026-06-21 13:19 GMT+3] ${body}`;
}

// Ground truth: OpenClaw core (src/auto-reply/reply/inbound-meta.ts,
// formatUntrustedJsonBlock + the "Chat history since last reply" call site)
// emits the recap as a JSON-fenced array under the same block grammar as the
// other untrusted-metadata blocks, not as free-text lines.
function historyRecapBlock(entries: Array<{ sender: string; timestamp_ms: number; body: string }>): string {
  return [
    "Chat history since last reply (untrusted, for context):",
    "```json",
    JSON.stringify(entries, null, 2),
    "```",
  ].join("\n");
}

function metadataWrappedWithRecap(recap: string, body: string): string {
  return (
    'Conversation info (untrusted metadata):\n```json\n{\n  "chat_id": "telegram:100000001",\n  "sender": "sam.rivera"\n}\n```\n\n' +
    recap +
    "\n\n" +
    body
  );
}

const TWO_ENTRY_RECAP = historyRecapBlock([
  { sender: "lee.chen", timestamp_ms: 1780000000000, body: "did the build finish?" },
  { sender: "sam.rivera", timestamp_ms: 1780000005000, body: "not sure, checking" },
]);

const FIVE_ENTRY_RECAP = historyRecapBlock([
  { sender: "lee.chen", timestamp_ms: 1780000000000, body: "did the build finish?" },
  { sender: "sam.rivera", timestamp_ms: 1780000005000, body: "not sure, checking" },
  { sender: "lee.chen", timestamp_ms: 1780000010000, body: "any update?" },
  { sender: "sam.rivera", timestamp_ms: 1780000015000, body: "almost done" },
  { sender: "lee.chen", timestamp_ms: 1780000020000, body: "ok take your time" },
]);

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

// Issue #973: OpenClaw also injects a host recap block ("Chat history since
// last reply (untrusted, for context):") between the metadata block(s) and
// the current message body when there are unread channel messages. Before
// this fix, the reduction above stripped only the metadata block(s), so a
// recap-bearing decorated face never matched its bare row and both got
// replayed to the model.
describe("openClawInboundBodiesMatch with a host chat-history recap block (issue #973)", () => {
  it("matches a decorated face carrying a recap block against its bare persisted row", () => {
    const bare = "what's the status on the deploy?";
    expect(openClawInboundBodiesMatch(metadataWrappedWithRecap(TWO_ENTRY_RECAP, bare), bare)).toBe(
      true,
    );
  });

  it("matches regardless of recap size (a growing chat-history window)", () => {
    const bare = "what's the status on the deploy?";
    expect(openClawInboundBodiesMatch(metadataWrappedWithRecap(FIVE_ENTRY_RECAP, bare), bare)).toBe(
      true,
    );
  });

  it("does NOT strip when the recap header is merely quoted in the user's own body (fail-closed)", () => {
    const bare =
      'Chat history since last reply (untrusted, for context): that\'s an odd phrase to quote, right?';
    // No ```json fence follows the header here, so it never structurally
    // validates as a recap block: the metadata-block strip alone already
    // recovers the match, and the quoted header stays part of the body.
    expect(openClawInboundBodiesMatch(metadataWrapped(bare), bare)).toBe(true);
  });

  it("does NOT strip a malformed recap block, so it stays part of the body and blocks the match (fail-closed)", () => {
    const bare = "what's the status on the deploy?";
    const malformedRecap = [
      "Chat history since last reply (untrusted, for context):",
      "```json",
      "not valid json{{{",
      "```",
    ].join("\n");
    expect(openClawInboundBodiesMatch(metadataWrappedWithRecap(malformedRecap, bare), bare)).toBe(
      false,
    );
  });

  it("does NOT strip a recap-shaped JSON object, not an array (the real emitter only ever emits an array)", () => {
    const bare = "what's the status on the deploy?";
    const objectShapedRecap = [
      "Chat history since last reply (untrusted, for context):",
      "```json",
      JSON.stringify({ sender: "lee.chen", body: "did the build finish?" }, null, 2),
      "```",
    ].join("\n");
    expect(openClawInboundBodiesMatch(metadataWrappedWithRecap(objectShapedRecap, bare), bare)).toBe(
      false,
    );
  });

  it("does NOT strip an empty recap array (the real emitter never emits one)", () => {
    const bare = "what's the status on the deploy?";
    const emptyRecap = historyRecapBlock([]);
    expect(openClawInboundBodiesMatch(metadataWrappedWithRecap(emptyRecap, bare), bare)).toBe(false);
  });

  it("leaves recap-like text at the start of a BARE row untouched (no metadata block, nothing to strip)", () => {
    const recapLikeBareBody = [
      "Chat history since last reply (untrusted, for context):",
      "```json",
      JSON.stringify([{ sender: "lee.chen", timestamp_ms: 1780000000000, body: "hello" }], null, 2),
      "```",
      "",
      "actual question here",
    ].join("\n");
    expect(openClawInboundModelFacingBody(recapLikeBareBody)).toBe(recapLikeBareBody.trim());
  });
});

// The recap is a snapshot of "history since last reply": it grows and
// changes turn to turn even when it decorates the same logical message, so it
// must not perturb the identity hash used to recognize repeat ingestion of
// that same decorated turn (mirrors how volatile keys are already excluded
// from the canonicalized Conversation info block).
describe("canonicalizeOpenClawInboundMetadataIdentityContent / buildMessageIdentityHash with a recap block", () => {
  it("produces the same identity hash for the same turn whether or not a recap is present", () => {
    const bare = "what's the status on the deploy?";
    const noRecap = metadataWrapped(bare);
    const withRecap = metadataWrappedWithRecap(TWO_ENTRY_RECAP, bare);
    expect(buildMessageIdentityHash("user", withRecap)).toBe(buildMessageIdentityHash("user", noRecap));
  });

  it("produces the same identity hash regardless of how many entries the recap carries", () => {
    const bare = "what's the status on the deploy?";
    const small = metadataWrappedWithRecap(TWO_ENTRY_RECAP, bare);
    const large = metadataWrappedWithRecap(FIVE_ENTRY_RECAP, bare);
    expect(buildMessageIdentityHash("user", large)).toBe(buildMessageIdentityHash("user", small));
  });

  it("does NOT fold a malformed recap block into the canonicalized identity content", () => {
    const bare = "what's the status on the deploy?";
    const malformedRecap = [
      "Chat history since last reply (untrusted, for context):",
      "```json",
      "not valid json{{{",
      "```",
    ].join("\n");
    const withMalformedRecap = metadataWrappedWithRecap(malformedRecap, bare);
    const withoutRecap = metadataWrapped(bare);
    expect(
      canonicalizeOpenClawInboundMetadataIdentityContent("user", withMalformedRecap),
    ).not.toBe(canonicalizeOpenClawInboundMetadataIdentityContent("user", withoutRecap));
  });
});

// Issue #973, iteration 2: the fleet was still running a 2026.6.10-era
// OpenClaw core whose recap emitter predates the JSON-array rendering above.
// Ground truth: openclaw-fork src/auto-reply/reply/inbound-meta.ts,
// formatChatWindowMessage (line 233) invoked from the "Chat history since last
// reply" call site (line ~723-747, since commit ba53782363, "render chat
// history since last reply as per-message prose"). Each entry renders as ONE
// line: an optional "#<message_id>" token, an optional "<weekday>
// <YYYY-MM-DD> <HH:MM:SS> <tz>" timestamp token (each independently omitted
// when its source field is absent -- the emitter's own
// "renders chat history as per-message prose" test in inbound-meta.test.ts
// renders `#1001 sam.rivera: ...` with NO timestamp at all), then
// "<sender>: <content>". Unlike the JSON form there is no hard terminator
// (no closing fence), so the block only ends at a blank line or end of
// content; a run of otherwise-valid lines that peters out into anything else
// must not be partially stripped (fail-closed on the whole block).
function historyRecapLineBlock(
  entries: Array<{ id: string; timestamp: string; sender: string; body: string }>,
): string {
  return [
    "Chat history since last reply (untrusted, for context):",
    ...entries.map((e) => `#${e.id} ${e.timestamp} ${e.sender}: ${e.body}`),
  ].join("\n");
}

function metadataWrappedWithLineRecap(recap: string, body: string): string {
  return (
    'Conversation info (untrusted metadata):\n```json\n{\n  "chat_id": "telegram:100000001",\n  "sender": "sam.rivera"\n}\n```\n\n' +
    recap +
    "\n\n" +
    body
  );
}

const TWO_ENTRY_LINE_RECAP = historyRecapLineBlock([
  {
    id: "1780000000.000100",
    timestamp: "Mon 2026-07-06 15:05:54 GMT+3",
    sender: "lee.chen",
    body: "did the build finish?",
  },
  {
    id: "1780000005.000200",
    timestamp: "Mon 2026-07-06 15:06:34 GMT+3",
    sender: "sam.rivera",
    body: "not sure, checking",
  },
]);

const FIVE_ENTRY_LINE_RECAP = historyRecapLineBlock([
  {
    id: "1780000000.000100",
    timestamp: "Mon 2026-07-06 15:05:54 GMT+3",
    sender: "lee.chen",
    body: "did the build finish?",
  },
  {
    id: "1780000005.000200",
    timestamp: "Mon 2026-07-06 15:06:34 GMT+3",
    sender: "sam.rivera",
    body: "not sure, checking",
  },
  {
    id: "1780000010.000300",
    timestamp: "Mon 2026-07-06 15:07:10 GMT+3",
    sender: "lee.chen",
    body: "any update?",
  },
  {
    id: "1780000015.000400",
    timestamp: "Mon 2026-07-06 15:07:45 GMT+3",
    sender: "sam.rivera",
    body: "almost done",
  },
  {
    id: "1780000020.000500",
    timestamp: "Mon 2026-07-06 15:08:20 GMT+3",
    sender: "lee.chen",
    body: "ok take your time",
  },
]);

describe("openClawInboundBodiesMatch with a 6.10-era line-format host chat-history recap (issue #973)", () => {
  it("matches a decorated face carrying a line-format recap block against its bare persisted row", () => {
    const bare = "what's the status on the deploy?";
    expect(
      openClawInboundBodiesMatch(metadataWrappedWithLineRecap(TWO_ENTRY_LINE_RECAP, bare), bare),
    ).toBe(true);
  });

  it("matches regardless of line-format recap size (a growing chat-history window)", () => {
    const bare = "what's the status on the deploy?";
    expect(
      openClawInboundBodiesMatch(metadataWrappedWithLineRecap(FIVE_ENTRY_LINE_RECAP, bare), bare),
    ).toBe(true);
  });

  it("recognizes entry lines whose sender contains a space (a real display name)", () => {
    const bare = "what's the status on the deploy?";
    const recap = historyRecapLineBlock([
      {
        id: "1780000000.000100",
        timestamp: "Mon 2026-07-06 15:05:54 GMT+3",
        sender: "Sam Rivera",
        body: "did the build finish?",
      },
    ]);
    expect(openClawInboundBodiesMatch(metadataWrappedWithLineRecap(recap, bare), bare)).toBe(true);
  });

  it("recognizes entry lines whose sender contains a colon (unusual but structurally permitted)", () => {
    const bare = "what's the status on the deploy?";
    const recap = historyRecapLineBlock([
      {
        id: "1780000000.000100",
        timestamp: "Mon 2026-07-06 15:05:54 GMT+3",
        sender: "erin:oncall",
        body: "did the build finish?",
      },
    ]);
    expect(openClawInboundBodiesMatch(metadataWrappedWithLineRecap(recap, bare), bare)).toBe(true);
  });

  it("recognizes a media-only entry line (bracketed content-type tag, no body text)", () => {
    const bare = "what's the status on the deploy?";
    const recap = [
      "Chat history since last reply (untrusted, for context):",
      "#1780000000.000100 Mon 2026-07-06 15:05:54 GMT+3 lee.chen: [image/jpeg]",
    ].join("\n");
    expect(openClawInboundBodiesMatch(metadataWrappedWithLineRecap(recap, bare), bare)).toBe(true);
  });

  it("does NOT strip when the recap header is merely quoted in the user's own body (fail-closed)", () => {
    const bare =
      'Chat history since last reply (untrusted, for context): that\'s an odd phrase to quote, right?';
    expect(openClawInboundBodiesMatch(metadataWrapped(bare), bare)).toBe(true);
  });

  it("does NOT strip a line carrying neither a message-id nor a timestamp anchor (indistinguishable from ordinary prose, fail-closed)", () => {
    const bare = "what's the status on the deploy?";
    const unanchoredRecap = [
      "Chat history since last reply (untrusted, for context):",
      "lee.chen: did the build finish?",
    ].join("\n");
    expect(
      openClawInboundBodiesMatch(metadataWrappedWithLineRecap(unanchoredRecap, bare), bare),
    ).toBe(false);
  });

  it("does NOT strip a malformed entry line (no colon separator), so it blocks the match (fail-closed)", () => {
    const bare = "what's the status on the deploy?";
    const malformedRecap = [
      "Chat history since last reply (untrusted, for context):",
      "#1780000000.000100 Mon 2026-07-06 15:05:54 GMT+3 lee.chen did the build finish",
    ].join("\n");
    expect(
      openClawInboundBodiesMatch(metadataWrappedWithLineRecap(malformedRecap, bare), bare),
    ).toBe(false);
  });

  it("does NOT partially strip a run of valid entry lines that is not properly terminated by a blank line (fail-closed on the whole block)", () => {
    const bare = "what's the status on the deploy?";
    const improperlyTerminated = [
      "Chat history since last reply (untrusted, for context):",
      "#1780000000.000100 Mon 2026-07-06 15:05:54 GMT+3 lee.chen: did the build finish?",
      "directly attached line, not blank, not a valid entry either",
    ].join("\n");
    const decorated = metadataWrapped(`${improperlyTerminated}\n\n${bare}`);
    expect(openClawInboundBodiesMatch(decorated, bare)).toBe(false);
  });

  it("leaves recap-like line-format text at the start of a BARE row untouched (no metadata block, nothing to strip)", () => {
    const recapLikeBareBody = [
      "Chat history since last reply (untrusted, for context):",
      "#1780000000.000100 Mon 2026-07-06 15:05:54 GMT+3 lee.chen: hello",
      "",
      "actual question here",
    ].join("\n");
    expect(openClawInboundModelFacingBody(recapLikeBareBody)).toBe(recapLikeBareBody.trim());
  });
});

describe("canonicalizeOpenClawInboundMetadataIdentityContent / buildMessageIdentityHash with a line-format recap block", () => {
  it("produces the same identity hash for the same turn whether or not a line-format recap is present", () => {
    const bare = "what's the status on the deploy?";
    const noRecap = metadataWrapped(bare);
    const withRecap = metadataWrappedWithLineRecap(TWO_ENTRY_LINE_RECAP, bare);
    expect(buildMessageIdentityHash("user", withRecap)).toBe(buildMessageIdentityHash("user", noRecap));
  });

  it("produces the same identity hash regardless of how many entries the line-format recap carries", () => {
    const bare = "what's the status on the deploy?";
    const small = metadataWrappedWithLineRecap(TWO_ENTRY_LINE_RECAP, bare);
    const large = metadataWrappedWithLineRecap(FIVE_ENTRY_LINE_RECAP, bare);
    expect(buildMessageIdentityHash("user", large)).toBe(buildMessageIdentityHash("user", small));
  });

  it("does NOT fold a malformed line-format recap block into the canonicalized identity content", () => {
    const bare = "what's the status on the deploy?";
    const malformedRecap = [
      "Chat history since last reply (untrusted, for context):",
      "#1780000000.000100 Mon 2026-07-06 15:05:54 GMT+3 lee.chen did the build finish",
    ].join("\n");
    const withMalformedRecap = metadataWrappedWithLineRecap(malformedRecap, bare);
    const withoutRecap = metadataWrapped(bare);
    expect(
      canonicalizeOpenClawInboundMetadataIdentityContent("user", withMalformedRecap),
    ).not.toBe(canonicalizeOpenClawInboundMetadataIdentityContent("user", withoutRecap));
  });
});

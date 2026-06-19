const OPENCLAW_INBOUND_METADATA_BLOCK_RE =
  /^(Conversation info \(untrusted metadata\)|Sender \(untrusted metadata\)):\r?\n```json\r?\n([\s\S]*?)\r?\n```/;

const CONVERSATION_INFO_KEYS = new Set([
  "chat_id",
  "message_id",
  "reply_to_id",
  "sender_id",
  "conversation_label",
  "sender",
  "timestamp",
  "group_subject",
  "group_channel",
  "group_space",
  "group_members",
  "thread_label",
  "inbound_event_kind",
  "topic_id",
  "topic_name",
  "is_forum",
  "mention_reason",
  "mention_target",
  "mentioned_user_ids",
  "mentioned_usernames",
  "has_reply_context",
  "has_forwarded_context",
  "has_thread_starter",
  "history_count",
  "history_media_count",
  "history_truncated",
]);

const VOLATILE_CONVERSATION_INFO_KEYS = new Set([
  "message_id",
  "reply_to_id",
  "timestamp",
]);

const SENDER_INFO_KEYS = new Set([
  "label",
  "id",
  "name",
  "username",
  "tag",
  "e164",
]);

/**
 * Canonicalizes OpenClaw's injected inbound metadata preamble for user-message identity input.
 */
export function canonicalizeOpenClawInboundMetadataIdentityContent(
  role: string,
  content: string,
): string {
  if (role !== "user") {
    return content;
  }

  const { prelude, metadataCandidate } = splitOpenClawInboundMetadataPrelude(content);
  const conversationCandidate = metadataCandidate.trimStart();
  const conversationMatch = OPENCLAW_INBOUND_METADATA_BLOCK_RE.exec(conversationCandidate);
  const conversationHeading = conversationMatch?.[1] ?? "";
  const conversationRecord = conversationMatch
    ? parseOpenClawInboundMetadataRecord(conversationHeading, conversationMatch[2] ?? "")
    : null;
  const canonicalConversationJson = conversationRecord
    ? canonicalizeMetadataJson(conversationRecord, VOLATILE_CONVERSATION_INFO_KEYS)
    : null;
  if (
    !conversationMatch ||
    conversationHeading !== "Conversation info (untrusted metadata)" ||
    !canonicalConversationJson
  ) {
    return content;
  }

  let remaining = conversationCandidate.slice(conversationMatch[0].length);
  const canonicalBlocks = [
    formatCanonicalMetadataBlock(conversationHeading, canonicalConversationJson),
  ];
  const senderCandidate = remaining.trimStart();
  const senderMatch = OPENCLAW_INBOUND_METADATA_BLOCK_RE.exec(senderCandidate);
  const senderHeading = senderMatch?.[1] ?? "";
  const senderRecord = senderMatch
    ? parseOpenClawInboundMetadataRecord(senderHeading, senderMatch[2] ?? "")
    : null;
  const canonicalSenderJson = senderRecord
    ? canonicalizeMetadataJson(senderRecord, new Set())
    : null;
  if (
    senderMatch &&
    senderHeading === "Sender (untrusted metadata)" &&
    canonicalSenderJson
  ) {
    remaining = stripMetadataSeparator(senderCandidate.slice(senderMatch[0].length));
    canonicalBlocks.push(formatCanonicalMetadataBlock(senderHeading, canonicalSenderJson));
  } else {
    remaining = stripMetadataSeparator(remaining);
  }

  return remaining.trim().length > 0
    ? `${prelude}${canonicalBlocks.join("\n\n")}\n\n${remaining}`
    : content;
}

function splitOpenClawInboundMetadataPrelude(content: string): {
  prelude: string;
  metadataCandidate: string;
} {
  const trimmed = content.trimStart();
  if (trimmed.startsWith("Conversation info (untrusted metadata):")) {
    return { prelude: "", metadataCandidate: trimmed };
  }

  const deliveryPrelude = /^Delivery:[\s\S]*?\r?\n\r?\n(?=Conversation info \(untrusted metadata\):)/.exec(
    trimmed,
  );
  if (!deliveryPrelude) {
    return { prelude: "", metadataCandidate: trimmed };
  }
  return {
    prelude: deliveryPrelude[0],
    metadataCandidate: trimmed.slice(deliveryPrelude[0].length),
  };
}

function parseOpenClawInboundMetadataRecord(
  heading: string,
  json: string,
): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const knownKeys = getKnownKeysForHeading(heading);
  if (!knownKeys) {
    return null;
  }

  return Object.keys(parsed).some((key) => knownKeys.has(key))
    ? (parsed as Record<string, unknown>)
    : null;
}

function canonicalizeMetadataJson(
  record: Record<string, unknown>,
  volatileKeys: Set<string>,
): string | null {
  const stableEntries = Object.entries(record)
    .filter(([key]) => !volatileKeys.has(key))
    .map(([key, value]) => [key, canonicalizeJsonValue(value)] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  if (stableEntries.length === 0) {
    return null;
  }
  return JSON.stringify(Object.fromEntries(stableEntries));
}

function canonicalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJsonValue(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, nestedValue]) => [key, canonicalizeJsonValue(nestedValue)] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function formatCanonicalMetadataBlock(heading: string, json: string): string {
  return [heading + ":", "```json", json, "```"].join("\n");
}

function stripMetadataSeparator(content: string): string {
  return content.replace(/^[ \t]*(?:\r?\n)(?:[ \t]*(?:\r?\n))?/, "");
}

function getKnownKeysForHeading(heading: string): Set<string> | undefined {
  if (heading === "Conversation info (untrusted metadata)") {
    return CONVERSATION_INFO_KEYS;
  }
  if (heading === "Sender (untrusted metadata)") {
    return SENDER_INFO_KEYS;
  }
  return undefined;
}

const OPENCLAW_INBOUND_TIMESTAMP_PREFIX_RE =
  /^\s*\[[A-Za-z]{3}\s+\d{4}-\d{2}-\d{2}[^\]]*GMT[^\]]*\]\s*/;

const OPENCLAW_UNTRUSTED_BLOCK_HEADER_RE = /^.{1,80}\(untrusted[^)]*\):\s*$/;
const OPENCLAW_GENERATED_CONTEXT_LINE_RE = /^#\d+\s+\S+/;

/**
 * Extract the raw user body from an OpenClaw inbound message by first proving
 * there is a valid injected metadata preamble, then dropping each leading
 * untrusted-metadata block (Conversation info, Sender, Conversation context,
 * Reply chain/target, Forwarded message context, Thread starter, Location, ...
 * — the whole family) plus any leading channel timestamp before that preamble.
 *
 * Unlike `canonicalizeOpenClawInboundMetadataIdentityContent` (which preserves
 * stable metadata so two genuinely different messages keep distinct identity
 * hashes), this reduces an inbound turn to its body alone. It is used ONLY to
 * recognize that the bare transcript copy and the decorated model-facing copy
 * are the same logical turn during flush-lag adoption — it never feeds the
 * message identity hash, so the chat-aware identity design is unaffected.
 *
 * After the validated Conversation info block, strip only metadata shapes we
 * can recognize: the optional Sender JSON block and the generated chronological
 * context list. Bare user text that merely resembles a timestamp or metadata
 * block is returned exactly unchanged, so adoption fails closed instead of
 * collapsing distinct messages.
 */
export function extractOpenClawInboundBody(role: string, content: string): string {
  if (role !== "user" || typeof content !== "string") {
    return typeof content === "string" ? content : "";
  }
  const timestampMatch = OPENCLAW_INBOUND_TIMESTAMP_PREFIX_RE.exec(content);
  const withoutTimestamp = timestampMatch ? content.slice(timestampMatch[0].length) : content;
  return (
    extractBodyAfterValidatedOpenClawPreamble(withoutTimestamp) ??
    extractBodyAfterValidatedOpenClawPreamble(content) ??
    content
  );
}

function extractBodyAfterValidatedOpenClawPreamble(content: string): string | null {
  const { metadataCandidate } = splitOpenClawInboundMetadataPrelude(content);
  const conversationCandidate = metadataCandidate.trimStart();
  const conversationMatch = OPENCLAW_INBOUND_METADATA_BLOCK_RE.exec(conversationCandidate);
  const conversationHeading = conversationMatch?.[1] ?? "";
  const conversationRecord = conversationMatch
    ? parseOpenClawInboundMetadataRecord(conversationHeading, conversationMatch[2] ?? "")
    : null;
  if (
    !conversationMatch ||
    conversationHeading !== "Conversation info (untrusted metadata)" ||
    !conversationRecord
  ) {
    return null;
  }

  let remaining = stripMetadataSeparator(
    conversationCandidate.slice(conversationMatch[0].length),
  );
  remaining = stripOptionalSenderBlock(remaining);
  remaining = stripOptionalGeneratedContextBlock(remaining);
  return remaining;
}

function stripOptionalSenderBlock(content: string): string {
  const senderCandidate = content.trimStart();
  const senderMatch = OPENCLAW_INBOUND_METADATA_BLOCK_RE.exec(senderCandidate);
  const senderHeading = senderMatch?.[1] ?? "";
  const senderRecord = senderMatch
    ? parseOpenClawInboundMetadataRecord(senderHeading, senderMatch[2] ?? "")
    : null;
  if (
    !senderMatch ||
    senderHeading !== "Sender (untrusted metadata)" ||
    !senderRecord
  ) {
    return content;
  }
  return stripMetadataSeparator(senderCandidate.slice(senderMatch[0].length));
}

function stripOptionalGeneratedContextBlock(content: string): string {
  const firstLine = content.split(/\r?\n/, 1)[0] ?? "";
  if (!OPENCLAW_UNTRUSTED_BLOCK_HEADER_RE.test(firstLine)) {
    return content;
  }
  const nextSegmentMatch = /\r?\n\r?\n/.exec(content);
  const segment = nextSegmentMatch ? content.slice(0, nextSegmentMatch.index) : content;
  if (!isGeneratedOpenClawContextSegment(segment)) {
    return content;
  }
  if (!nextSegmentMatch) {
    return "";
  }
  return stripMetadataSeparator(content.slice(nextSegmentMatch.index + nextSegmentMatch[0].length));
}

function isGeneratedOpenClawContextSegment(segment: string): boolean {
  const lines = segment.split(/\r?\n/);
  const firstLine = lines[0] ?? "";
  if (!OPENCLAW_UNTRUSTED_BLOCK_HEADER_RE.test(firstLine)) {
    return false;
  }
  const bodyLines = lines.slice(1).filter((line) => line.trim().length > 0);
  return (
    bodyLines.length > 0 &&
    bodyLines.every((line) => OPENCLAW_GENERATED_CONTEXT_LINE_RE.test(line))
  );
}

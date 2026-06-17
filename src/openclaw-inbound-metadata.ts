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

const OPENCLAW_INBOUND_METADATA_BLOCK_RE =
  /^(Conversation info \(untrusted metadata\)|Sender \(untrusted metadata\)):\r?\n```json\r?\n([\s\S]*?)\r?\n```/;

// OpenClaw-version-coupled inbound decoration string: the header an OpenClaw
// runtime prepends to a user turn that carries an ambient room event (channel
// chatter the agent was not directly addressed by). Treated like the Delivery
// prelude, a non-anchoring wrapper (not real user content).
const OPENCLAW_ROOM_EVENT_HEADER = "[OpenClaw room event]";

const CONVERSATION_INFO_HEADING = "Conversation info (untrusted metadata):";

const OPENCLAW_INBOUND_TIMESTAMP_PREFIX_RE =
  /^\s*\[[A-Za-z]{3}\s+\d{4}-\d{2}-\d{2}[^\]]*GMT[^\]]*\]\s*/;

/**
 * Strip a single leading OpenClaw channel timestamp prefix ("[Sun 2026-06-21
 * 13:19 GMT+3] ...") from a value if present, returning the remainder. Used for
 * structural same-turn containment matching: the live current turn's body is
 * delivered timestamp-prefixed, while the bare persisted store row may be the
 * same body with or without that prefix. Stripping it on both sides lets the
 * containment check align them without any knowledge of the surrounding
 * decoration. A no-op when there is no recognized timestamp prefix.
 *
 * The "[<weekday> YYYY-MM-DD ... GMT...]" channel timestamp is the only
 * structurally-known volatile prefix; nothing else is recognized here.
 */
export function stripLeadingOpenClawInboundTimestamp(value: string): string {
  const match = OPENCLAW_INBOUND_TIMESTAMP_PREFIX_RE.exec(value);
  return match ? value.slice(match[0].length) : value;
}

/**
 * True when `content` begins with a genuine OpenClaw injected inbound-metadata
 * block (after an optional leading channel timestamp and `Delivery:` hint): a
 * heading line equal to a known untrusted-metadata sentinel ("Conversation info
 * (untrusted metadata):" / "Sender (untrusted metadata):"), immediately
 * followed by a ```json fenced body that parses to a non-array object carrying
 * at least one heading-specific key. That fenced-object-under-a-known-heading
 * frame is recognized as OpenClaw decoration for heuristic matching, but it is
 * still untrusted user-facing text until the host provides a trusted marker. A
 * user who merely quotes or types "(untrusted metadata)" in prose does not
 * reproduce the structured frame, so their message is not mistaken for
 * decoration.
 */
export function contentBeginsWithOpenClawInboundMetadataBlock(content: string): boolean {
  return extractBodyAfterOpenClawInboundMetadataBlock(content) !== null;
}

/**
 * Returns the user body after a recognized leading OpenClaw inbound metadata
 * prelude, or null when the content does not begin with one.
 */
export function extractBodyAfterOpenClawInboundMetadataBlock(content: string): string | null {
  const afterTimestamp = stripLeadingOpenClawInboundTimestamp(content.trimStart());
  const { metadataCandidate } = splitOpenClawInboundMetadataPrelude(afterTimestamp);
  const firstCandidate = metadataCandidate.trimStart();
  const firstMatch = OPENCLAW_INBOUND_METADATA_BLOCK_RE.exec(firstCandidate);
  if (!firstMatch) {
    return null;
  }
  if (parseOpenClawInboundMetadataRecord(firstMatch[1] ?? "", firstMatch[2] ?? "") === null) {
    return null;
  }

  let remaining = firstCandidate.slice(firstMatch[0].length);
  const secondCandidate = remaining.trimStart();
  const secondMatch = OPENCLAW_INBOUND_METADATA_BLOCK_RE.exec(secondCandidate);
  if (
    secondMatch &&
    parseOpenClawInboundMetadataRecord(secondMatch[1] ?? "", secondMatch[2] ?? "") !== null
  ) {
    remaining = secondCandidate.slice(secondMatch[0].length);
  }

  return stripMetadataSeparator(remaining);
}

/**
 * True when the runtime candidate begins with a recognized inbound-metadata
 * block and reduces to the same non-empty body as the persisted bare candidate.
 * Metadata and recap blocks are stripped only from the runtime side; the
 * persisted side gets timestamp-normalized but keeps metadata-shaped text
 * verbatim, because persisted content is user-authored unless another layer
 * proves otherwise. This is byte-equality of the full reduced bodies, not
 * containment, so an undecorated row, a distinct turn whose trailing line
 * merely matches a prior body, or a forged metadata frame concealing a
 * different body is never treated as the same turn (fail-closed).
 */
export function openClawInboundBodiesMatch(liveContent: string, bareContent: string): boolean {
  const liveBodyAfterMetadata = extractBodyAfterOpenClawInboundMetadataBlock(liveContent);
  if (liveBodyAfterMetadata === null) {
    return false;
  }
  const liveBody = stripLeadingOpenClawInboundTimestamp(liveBodyAfterMetadata);
  const bareBody = stripLeadingOpenClawInboundTimestamp(bareContent);
  return liveBody.trim().length > 0 && liveBody === bareBody;
}

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

/**
 * True only when a user row is an OpenClaw AMBIENT (non-anchoring) inbound
 * delivery, decided by the injected inbound metadata rather than the trailing
 * body. Such a row anchors no directed conversation, so a stuck offset-0
 * placeholder / checkpoint-missing frontier built only from these rows can
 * recover instead of freezing.
 *
 * Returns true ONLY when role === "user" AND a parseable "Conversation info
 * (untrusted metadata)" block is present (located through the same optional
 * "[OpenClaw room event]" header and "Delivery:" prelude the rest of this
 * module handles) AND the parsed metadata is either an explicit room event, or
 * a clearly un-addressed group delivery (is_group_chat === true AND
 * explicitly_mentioned_bot === false AND mention_source === "none").
 *
 * SAFETY (#824 contamination zone): under-match is the safe direction. Any
 * parse failure, a missing/unexpected flag, an addressed turn
 * (explicitly_mentioned_bot === true or mention_source !== "none"), or a
 * non-user role returns false. The un-addressed case requires the explicit
 * group-chat flag plus BOTH mention fields; if any are absent we do NOT treat
 * the row as ambient unless the event is an explicit room_event. A real
 * directed turn is never misclassified as ambient regardless of its trailing
 * body.
 */
export function isOpenClawAmbientInboundRecord(role: string, content: string): boolean {
  if (role !== "user") {
    return false;
  }

  let metadataBearing = content.trimStart();
  if (metadataBearing.startsWith(OPENCLAW_ROOM_EVENT_HEADER)) {
    const headingIndex = metadataBearing.indexOf(CONVERSATION_INFO_HEADING);
    if (headingIndex === -1) {
      return false;
    }
    metadataBearing = metadataBearing.slice(headingIndex);
  }

  const { metadataCandidate } = splitOpenClawInboundMetadataPrelude(metadataBearing);
  const conversationCandidate = metadataCandidate.trimStart();
  const conversationMatch = OPENCLAW_INBOUND_METADATA_BLOCK_RE.exec(conversationCandidate);
  if (!conversationMatch || conversationMatch[1] !== "Conversation info (untrusted metadata)") {
    return false;
  }

  const record = parseOpenClawInboundMetadataRecord(conversationMatch[1], conversationMatch[2] ?? "");
  if (!record) {
    return false;
  }

  if (record.inbound_event_kind === "room_event") {
    return true;
  }

  if (record.is_group_chat !== true) {
    return false;
  }

  const mentioned = record.explicitly_mentioned_bot;
  const mentionSource = record.mention_source;
  if (mentioned === true) {
    return false;
  }
  if (mentionSource !== undefined && mentionSource !== "none") {
    return false;
  }
  return mentioned === false && mentionSource === "none";
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

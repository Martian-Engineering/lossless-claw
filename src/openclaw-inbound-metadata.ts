const OPENCLAW_INBOUND_METADATA_BLOCK_RE =
  /^(Conversation info \(untrusted metadata\)|Sender \(untrusted metadata\)):\r?\n```json\r?\n([\s\S]*?)\r?\n```\s*/;

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

const SENDER_INFO_KEYS = new Set([
  "label",
  "id",
  "name",
  "username",
  "tag",
  "e164",
]);

export function canonicalizeOpenClawInboundMetadataIdentityContent(
  role: string,
  content: string,
): string {
  if (role !== "user") {
    return content;
  }

  let remaining = content;
  let strippedBlock = false;
  for (;;) {
    const candidate = remaining.trimStart();
    const match = OPENCLAW_INBOUND_METADATA_BLOCK_RE.exec(candidate);
    if (!match) {
      break;
    }
    if (!isOpenClawInboundMetadataRecord(match[1] ?? "", match[2] ?? "")) {
      return content;
    }
    remaining = candidate.slice(match[0].length);
    strippedBlock = true;
  }

  return strippedBlock && remaining.trim().length > 0 ? remaining : content;
}

function isOpenClawInboundMetadataRecord(heading: string, json: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return false;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }

  const knownKeys = getKnownKeysForHeading(heading);
  if (!knownKeys) {
    return false;
  }

  return Object.keys(parsed).some((key) => knownKeys.has(key));
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

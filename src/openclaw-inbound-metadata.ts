const OPENCLAW_INBOUND_METADATA_BLOCK_RE =
  /^(Conversation info \(untrusted metadata\)|Sender \(untrusted metadata\)):\r?\n```json\r?\n([\s\S]*?)\r?\n```/;

// Recap header text varies by fleet deployment/core version (multiple
// grammars are simultaneously live -- not every deployment has picked up the
// same core). One list keeps future header variants a one-line addition; each
// is tried against every recognized body shape below.
const OPENCLAW_INBOUND_HISTORY_RECAP_HEADERS = [
  "Chat history since last reply (untrusted, for context):",
  "Conversation context (untrusted, chronological, selected for current message):",
];

const OPENCLAW_INBOUND_CONTEXT_BLOCK_HEADINGS = [
  "Thread starter (untrusted, for context)",
  "Reply chain of current user message (untrusted, nearest first)",
  "Reply target of current user message (untrusted, for context)",
  "Forwarded message context (untrusted metadata)",
  "Location (untrusted metadata)",
];

function escapeOpenClawRecapHeaderRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const OPENCLAW_INBOUND_CONTEXT_BLOCK_RE = new RegExp(
  `^(?:${OPENCLAW_INBOUND_CONTEXT_BLOCK_HEADINGS.map(
    escapeOpenClawRecapHeaderRegExpLiteral,
  ).join("|")}):` + String.raw`\r?\n\`\`\`json\r?\n([\s\S]*?)\r?\n\`\`\``,
);

const OPENCLAW_INBOUND_HISTORY_RECAP_HEADER_SRC = `(?:${OPENCLAW_INBOUND_HISTORY_RECAP_HEADERS.map(
  escapeOpenClawRecapHeaderRegExpLiteral,
).join("|")})`;

// Ground truth: OpenClaw core's formatUntrustedJsonBlock (used for every
// untrusted-metadata block, including this one) always emits heading + a
// ```json fence + JSON.stringify(payload, null, 2) + closing fence. The recap
// heading is fixed text; unlike the metadata blocks its payload is a JSON
// ARRAY (the bounded chat-history window), not an object. This is the current
// (post-2026.6.10) emission shape.
const OPENCLAW_INBOUND_HISTORY_RECAP_BLOCK_RE = new RegExp(
  `^${OPENCLAW_INBOUND_HISTORY_RECAP_HEADER_SRC}` +
    String.raw`\r?\n\`\`\`json\r?\n([\s\S]*?)\r?\n\`\`\``,
);

// Ground truth (2026.6.10-era fleet, predates the JSON-array rendering above):
// OpenClaw core's formatChatWindowMessage (openclaw-fork
// src/auto-reply/reply/inbound-meta.ts:233), invoked from the "Chat history
// since last reply" call site (same file, ~line 723-747, since commit
// ba53782363 "render chat history since last reply as per-message prose"),
// renders each history entry as ONE line: an optional "#<message_id>" token,
// an optional "<weekday> <YYYY-MM-DD> <HH:MM:SS> <tz>" timestamp token (each
// independently omitted when its source field is absent -- confirmed by that
// same commit's own "renders chat history as per-message prose" test, which
// renders `#1001 sam.rivera: ...` with no timestamp at all), then
// "<sender>: <content>". A line carrying NEITHER token is indistinguishable
// from ordinary prose, so it is deliberately excluded from recognition here
// (fail-closed: at least one anchor token is required).
const OPENCLAW_INBOUND_HISTORY_RECAP_LINE_ID_PREFIX_RE = /^#\S+ /;
const OPENCLAW_INBOUND_HISTORY_RECAP_LINE_TIMESTAMP_PREFIX_RE =
  /^[A-Za-z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \S+ /;

// Unlike the JSON form (self-delimiting via the closing fence), prose lines
// have no hard terminator: the real emitter just stops emitting lines, and
// buildInboundUserContextPrefix joins every block (including this one) with
// blocks.filter(Boolean).join("\n\n"). So the only structurally valid ways
// for a run of entry lines to end are a blank-line block separator or end of
// content. A run that peters out into anything else (a line that is neither a
// valid entry nor a blank separator) fails the WHOLE match, so it is never
// partially stripped up to that point.
//
// Deliberately implemented as a line walker rather than one composite
// `(?:ENTRY)(?:\r?\n(?:ENTRY))*(?=terminator)` regex: entry lines are
// internally ambiguous (three optional-prefix alternates, sender/content
// split at any ": "), so on a long run whose terminator check fails the
// backtracking engine explores the cross-product of every per-line ambiguity
// and goes catastrophic (minutes of blocking on a ~200-entry colon-heavy
// recap; the shape real group chats produce whenever a recap entry contains
// its own newlines). A shorter run can never satisfy the terminator that the
// maximal run failed (the next char after an intermediate entry is always its
// successor line, never a blank separator or end), so the walk is all-or-
// nothing greedy and strictly linear.
function matchLeadingOpenClawInboundHistoryRecapLineBlock(candidate: string): number {
  const header = OPENCLAW_INBOUND_HISTORY_RECAP_HEADERS.find((headerText) =>
    candidate.startsWith(headerText),
  );
  if (header === undefined) {
    return 0;
  }
  let cursor = header.length;
  if (candidate.startsWith("\r\n", cursor)) {
    cursor += 2;
  } else if (candidate.startsWith("\n", cursor)) {
    cursor += 1;
  } else {
    return 0;
  }

  let matchedEnd = -1;
  while (cursor < candidate.length) {
    const newlineIndex = candidate.indexOf("\n", cursor);
    let lineTextEnd = newlineIndex === -1 ? candidate.length : newlineIndex;
    if (lineTextEnd > cursor && candidate.charCodeAt(lineTextEnd - 1) === 13) {
      lineTextEnd -= 1;
    }
    if (!isOpenClawInboundHistoryRecapEntryLine(candidate.slice(cursor, lineTextEnd))) {
      break;
    }
    matchedEnd = lineTextEnd;
    if (newlineIndex === -1) {
      break;
    }
    cursor = newlineIndex + 1;
  }
  if (matchedEnd < 0) {
    return 0;
  }

  const rest = candidate.slice(matchedEnd);
  const terminated =
    rest.length === 0 ||
    rest === "\n" ||
    rest === "\r\n" ||
    rest.startsWith("\n\n") ||
    rest.startsWith("\n\r\n") ||
    rest.startsWith("\r\n\n") ||
    rest.startsWith("\r\n\r\n");
  return terminated ? matchedEnd : 0;
}

// "<sender>: <content>" with both sides non-empty: at least one character
// before the first eligible ": " and at least one after it. (A CR-only
// content survives the composite-regex form via `.` matching \r; the walker
// treats it as empty and rejects -- the conservative direction.)
function recapEntryLineHasSenderAndContent(remainder: string): boolean {
  const separatorIndex = remainder.indexOf(": ", 1);
  return separatorIndex !== -1 && separatorIndex + 2 < remainder.length;
}

function isOpenClawInboundHistoryRecapEntryLine(line: string): boolean {
  const idMatch = OPENCLAW_INBOUND_HISTORY_RECAP_LINE_ID_PREFIX_RE.exec(line);
  if (idMatch) {
    const afterId = line.slice(idMatch[0].length);
    const timestampMatch =
      OPENCLAW_INBOUND_HISTORY_RECAP_LINE_TIMESTAMP_PREFIX_RE.exec(afterId);
    if (
      timestampMatch &&
      recapEntryLineHasSenderAndContent(afterId.slice(timestampMatch[0].length))
    ) {
      return true;
    }
    return recapEntryLineHasSenderAndContent(afterId);
  }
  const timestampMatch = OPENCLAW_INBOUND_HISTORY_RECAP_LINE_TIMESTAMP_PREFIX_RE.exec(line);
  return (
    timestampMatch !== null &&
    recapEntryLineHasSenderAndContent(line.slice(timestampMatch[0].length))
  );
}

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
  return extractBodyAfterOpenClawInboundMetadataBlockWithPolicy(content, true);
}

// Shared metadata/recap reduction. The body matcher first disables injected
// stripping to preserve an exact user-authored-tag match, then enables it as
// the plugin-injection fallback.
function extractBodyAfterOpenClawInboundMetadataBlockWithPolicy(
  content: string,
  stripInjectedContext: boolean,
): string | null {
  const afterTimestamp = stripLeadingOpenClawInboundTimestamp(content.trimStart());
  const { metadataCandidate } = splitOpenClawInboundMetadataPrelude(afterTimestamp);
  const firstCandidate = metadataCandidate.trimStart();
  const firstMatch = OPENCLAW_INBOUND_METADATA_BLOCK_RE.exec(firstCandidate);
  if (!firstMatch) {
    return null;
  }
  const firstRecord = parseOpenClawInboundMetadataRecord(
    firstMatch[1] ?? "",
    firstMatch[2] ?? "",
  );
  if (firstRecord === null) {
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

  if (stripInjectedContext) {
    remaining = stripLeadingInjectedContextTagBlocks(remaining);
  }
  // The recap strip must not require the metadata to announce history:
  // `history_count` is a host announcement the host demonstrably omits on
  // some channels (live telegram records carry a recap block with no
  // history_count field at all). The structural validators inside
  // matchLeadingOpenClawInboundHistoryRecap are the real gate; the record
  // field is at most a hint, never a precondition.
  {
    const contextSplit = splitLeadingOpenClawInboundContextBlocks(remaining);
    const recapCandidate = contextSplit.remaining.trimStart();
    const recapLength = matchLeadingOpenClawInboundHistoryRecap(recapCandidate);
    if (recapLength > 0) {
      remaining = recapCandidate.slice(recapLength);
    }
  }
  if (stripInjectedContext) {
    remaining = stripLeadingInjectedContextTagBlocks(remaining);
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
  const bareBody = stripLeadingOpenClawInboundTimestamp(bareContent);
  const exactLiveBodyAfterMetadata = extractBodyAfterOpenClawInboundMetadataBlockWithPolicy(
    liveContent,
    false,
  );
  if (exactLiveBodyAfterMetadata === null) {
    return false;
  }
  const exactLiveBody = stripLeadingOpenClawInboundTimestamp(exactLiveBodyAfterMetadata);
  return exactLiveBody.trim().length > 0 && exactLiveBody === bareBody;
}

/**
 * Match after stripping known injected-context blocks from the runtime face.
 * Use only where another strong signal proves the aligned rows are the same
 * turn, because the tag names themselves are user-typeable.
 */
export function openClawInboundBodiesMatchWithInjectedContext(
  liveContent: string,
  bareContent: string,
): boolean {
  if (openClawInboundBodiesMatch(liveContent, bareContent)) {
    return true;
  }
  const liveBodyAfterMetadata = extractBodyAfterOpenClawInboundMetadataBlock(liveContent);
  if (liveBodyAfterMetadata === null) {
    return false;
  }
  const liveBody = stripLeadingOpenClawInboundTimestamp(liveBodyAfterMetadata);
  const bareBody = stripLeadingOpenClawInboundTimestamp(bareContent);
  return liveBody.trim().length > 0 && liveBody === bareBody;
}

/**
 * True when a live metadata-decorated face reduces to the same non-empty body
 * as an assembled face. Injected tags are stripped only from the live side;
 * the assembled side stays verbatim because those tags are user-typeable.
 * Use only after the caller proves both faces belong to the current turn.
 */
export function openClawInboundDecoratedBodiesMatch(
  liveContent: string,
  assembledContent: string,
): boolean {
  const liveBody = extractBodyAfterOpenClawInboundMetadataBlock(liveContent);
  const assembledBody = extractBodyAfterOpenClawInboundMetadataBlockWithPolicy(
    assembledContent,
    false,
  );
  return (
    liveBody !== null &&
    assembledBody !== null &&
    liveBody.trim().length > 0 &&
    liveBody === assembledBody
  );
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

const VOLATILE_CONVERSATION_INFO_KEYS_WITH_HISTORY = new Set([
  ...VOLATILE_CONVERSATION_INFO_KEYS,
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

const HISTORY_RECAP_ENTRY_KEYS = new Set(["sender", "timestamp_ms", "message_id", "body", "media"]);

/**
 * Canonicalizes OpenClaw's injected inbound metadata preamble for user-message identity input.
 */
export function canonicalizeOpenClawInboundMetadataIdentityContent(
  role: string,
  content: string,
): string {
  return canonicalizeOpenClawInboundMetadataIdentityContentWithRecapPolicy(role, content, true);
}

/**
 * Reproduces the identity canonicalization used before host recaps became volatile.
 * This is retained only so startup migration can recognize and repair version-1 hashes.
 */
export function canonicalizeOpenClawInboundMetadataIdentityContentBeforeHistoryRecap(
  role: string,
  content: string,
): string {
  return canonicalizeOpenClawInboundMetadataIdentityContentWithRecapPolicy(role, content, false);
}

function canonicalizeOpenClawInboundMetadataIdentityContentWithRecapPolicy(
  role: string,
  content: string,
  stripHistoryRecap: boolean,
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
    ? canonicalizeMetadataJson(
        conversationRecord,
        stripHistoryRecap && hasOpenClawInboundHistory(conversationRecord)
          ? VOLATILE_CONVERSATION_INFO_KEYS_WITH_HISTORY
          : VOLATILE_CONVERSATION_INFO_KEYS,
      )
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
  let afterMetadataBlocks: string;
  if (
    senderMatch &&
    senderHeading === "Sender (untrusted metadata)" &&
    canonicalSenderJson
  ) {
    afterMetadataBlocks = senderCandidate.slice(senderMatch[0].length);
    canonicalBlocks.push(formatCanonicalMetadataBlock(senderHeading, canonicalSenderJson));
  } else {
    afterMetadataBlocks = remaining;
  }

  // The recap is a snapshot of "history since last reply": it grows and
  // shifts turn to turn even when it decorates the same logical message, so
  // it is dropped entirely from the identity input rather than canonicalized
  // (unlike the metadata blocks above, which keep their stable fields).
  if (
    stripHistoryRecap &&
    conversationRecord !== null &&
    hasOpenClawInboundHistory(conversationRecord)
  ) {
    const contextSplit = splitLeadingOpenClawInboundContextBlocks(afterMetadataBlocks);
    const recapCandidate = contextSplit.remaining.trimStart();
    const recapLength = matchLeadingOpenClawInboundHistoryRecap(recapCandidate);
    if (recapLength > 0) {
      const contextPrefix = stripMetadataSeparator(contextSplit.blocksText).trimEnd();
      const afterRecap = stripMetadataSeparator(recapCandidate.slice(recapLength));
      remaining = contextPrefix
        ? afterRecap.trim().length > 0
          ? `${contextPrefix}\n\n${afterRecap}`
          : contextPrefix
        : afterRecap;
    } else {
      remaining = stripMetadataSeparator(afterMetadataBlocks);
    }
  } else {
    remaining = stripMetadataSeparator(afterMetadataBlocks);
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

function hasOpenClawInboundHistory(record: Record<string, unknown>): boolean {
  const historyCount = record.history_count;
  return typeof historyCount === "number" && Number.isInteger(historyCount) && historyCount > 0;
}

// Injected-context tag blocks that memory/context plugins prepend to the
// model-facing body via before_prompt_build. On decorated channels they sit
// between the metadata prelude and the user body on the RUNTIME face only;
// persisted rows never carry them (plugins inject at prompt-build, strictly
// after the bare row is persisted), so reducing them off the runtime side is
// what lets the same-turn collapse see through a memory-bearing decorated
// copy. Only a COMPLETE <tag>...</tag> block for these exact names is
// stripped; an unclosed or unknown tag stays in the body and blocks the match
// (fail-closed).
// Exported as the single source of truth for injected-context TAG names:
// live-coverage.ts derives its marker-recognition list from this same const,
// so the reduction here and the recognition gate there can never disagree on
// which tags count as injected plugin context.
export const OPENCLAW_INJECTED_CONTEXT_TAG_NAMES = [
  "relevant-memories",
  "relevant_memories",
  "hindsight_memories",
  "inherited-rules",
  "derived-focus",
  "error-detected",
  "active_memory_plugin",
] as const;

function stripLeadingInjectedContextTagBlocks(content: string): string {
  let remaining = content;
  while (true) {
    const candidate = remaining.trimStart();
    const name = OPENCLAW_INJECTED_CONTEXT_TAG_NAMES.find((tag) =>
      candidate.startsWith(`<${tag}>`),
    );
    if (name === undefined) {
      return remaining;
    }
    const closeTag = `</${name}>`;
    const closeIndex = candidate.indexOf(closeTag);
    if (closeIndex < 0) {
      return remaining;
    }
    remaining = candidate.slice(closeIndex + closeTag.length);
  }
}

function splitLeadingOpenClawInboundContextBlocks(content: string): {
  blocksText: string;
  remaining: string;
} {
  let remaining = content;
  let blocksText = "";
  while (true) {
    const candidate = remaining.trimStart();
    const leadingWhitespace = remaining.slice(0, remaining.length - candidate.length);
    const match = OPENCLAW_INBOUND_CONTEXT_BLOCK_RE.exec(candidate);
    if (!match || !isValidOpenClawInboundContextPayload(match[1] ?? "")) {
      return { blocksText, remaining };
    }
    blocksText += leadingWhitespace + match[0];
    remaining = candidate.slice(match[0].length);
  }
}

function isValidOpenClawInboundContextPayload(json: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return false;
  }
  return parsed !== null && (typeof parsed === "object" || Array.isArray(parsed));
}

/**
 * True when `json` parses to a non-empty array of plain objects each carrying
 * at least one recognized chat-history-entry key. The recap block serializes
 * a list (unlike the metadata blocks, which serialize a single object), so it
 * needs its own array-shaped validation to stay fail-closed on anything else
 * (malformed JSON, an object, an empty array, or an array of non-object
 * entries).
 */
function isValidOpenClawInboundHistoryRecapPayload(json: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return false;
  }
  return (
    Array.isArray(parsed) &&
    parsed.length > 0 &&
    parsed.every(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        Object.keys(entry).some((key) => HISTORY_RECAP_ENTRY_KEYS.has(key)),
    )
  );
}

/**
 * Length of a structurally validated leading host chat-history recap block in
 * `candidate` (already trimmed of leading whitespace by the caller), or 0 when
 * none is present. Recognizes either the current JSON-array form or the
 * 2026.6.10-era per-line prose form (both are live on the fleet at once, since
 * not every deployment has picked up the JSON-rendering change yet).
 * Fail-closed in both forms: a user quoting the header in prose without a
 * fenced array or a valid entry line immediately following, a
 * malformed/empty/non-array JSON payload, or a run of prose lines not
 * properly terminated by a blank line or end of content, all strip nothing.
 */
function matchLeadingOpenClawInboundHistoryRecap(candidate: string): number {
  const jsonMatch = OPENCLAW_INBOUND_HISTORY_RECAP_BLOCK_RE.exec(candidate);
  if (jsonMatch) {
    return isValidOpenClawInboundHistoryRecapPayload(jsonMatch[1] ?? "") ? jsonMatch[0].length : 0;
  }
  return matchLeadingOpenClawInboundHistoryRecapLineBlock(candidate);
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

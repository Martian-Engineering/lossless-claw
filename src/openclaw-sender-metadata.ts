/** Sender identity fields persisted from OpenClaw's host-owned message envelope. */
export type OpenClawSenderMetadata = {
  senderId?: string;
  senderName?: string;
  senderUsername?: string;
};

const OPENCLAW_SENDER_KEYS = ["senderId", "senderName", "senderUsername"] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// Copy only the three stable host-envelope fields. Values remain byte-for-byte
// intact after non-empty validation so storage is lossless and JSON formatting
// can safely escape control characters at the summarization boundary.
function normalizeSenderMetadata(value: unknown): OpenClawSenderMetadata | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const metadata: OpenClawSenderMetadata = {};
  for (const key of OPENCLAW_SENDER_KEYS) {
    const field = record[key];
    if (typeof field === "string" && field.trim().length > 0) {
      metadata[key] = field;
    }
  }
  return Object.keys(metadata).length > 0 ? metadata : null;
}

/** Extract the allowlisted sender identity from a user message's OpenClaw envelope. */
export function extractOpenClawSenderMetadata(message: unknown): OpenClawSenderMetadata | null {
  const record = asRecord(message);
  if (!record || record.role !== "user") {
    return null;
  }
  return normalizeSenderMetadata(record.__openclaw);
}

/** Serialize sender identity for the nullable SQLite messages column. */
export function serializeOpenClawSenderMetadata(
  metadata: OpenClawSenderMetadata | null | undefined,
): string | null {
  const normalized = normalizeSenderMetadata(metadata);
  return normalized ? JSON.stringify(normalized) : null;
}

/** Parse an existing SQLite sender-identity value, tolerating legacy or malformed rows. */
export function parseOpenClawSenderMetadata(
  value: string | null | undefined,
): OpenClawSenderMetadata | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  try {
    return normalizeSenderMetadata(JSON.parse(value));
  } catch {
    return null;
  }
}

/** Format sender identity for leaf-summary source text as explicitly untrusted metadata. */
export function formatOpenClawSenderForSummary(
  metadata: OpenClawSenderMetadata | null | undefined,
): string | null {
  const normalized = normalizeSenderMetadata(metadata);
  return normalized
    ? `speaker (untrusted metadata): ${JSON.stringify(normalized)}`
    : null;
}

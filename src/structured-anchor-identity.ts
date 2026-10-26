import { stripModelIdentityFromMetadataJson, TOOL_RAW_TYPES } from "./message-content.js";
import { canonicalizeReplayRawMetadata, pickTopLevelReplayMetadata } from "./replay-metadata.js";
import type { CreateMessagePartInput } from "./store/conversation-store.js";
import { asRecord, safeBoolean, safeString } from "./value-utils.js";

// Sort nested object keys while preserving array order for payload comparisons.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, canonical(nested)]),
    );
  }
  return value;
}

// Retain malformed JSON verbatim so distinct corrupt values cannot compare equal.
function json(value: string | null | undefined): unknown {
  if (value == null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function toolProvenance(part: Omit<CreateMessagePartInput, "sessionId">) {
  const metadata = asRecord(json(part.metadata));
  const envelope = pickTopLevelReplayMetadata(metadata ?? {});
  const raw = asRecord(metadata?.raw);
  // Externalized text blocks gain synthetic tool fields. Their original
  // provenance remains in the envelope; buildMessageParts promotes rawType to
  // type, but retains the replacement's rawType/externalization markers.
  const externalizedText = raw?.toolOutputExternalized === true &&
    raw.externalizationReason === "large_tool_result" && raw.rawType !== undefined;
  const block = raw && !externalizedText && TOOL_RAW_TYPES.has(safeString(raw.type) ?? "")
    ? canonicalizeReplayRawMetadata(raw)
    : undefined;
  const id = block || (!raw && part.partType === "tool")
    ? part.toolCallId ?? safeString(block?.tool_use_id) ?? safeString(block?.call_id) ?? safeString(envelope.toolCallId)
    : safeString(envelope.toolCallId);
  const name = block || (!raw && part.partType === "tool")
    ? part.toolName ?? safeString(block?.name) ?? safeString(envelope.toolName)
    : safeString(envelope.toolName);
  const isError = (block ? safeBoolean(raw?.is_error) ?? safeBoolean(block.isError) : undefined)
    ?? safeBoolean(envelope.isError);
  if (!block && id == null && name == null && isError === undefined) return null;
  return {
    id: id ?? null, name: name ?? null, isError: isError ?? null,
    envelopeId: safeString(envelope.toolCallId) ?? null,
    envelopeName: safeString(envelope.toolName) ?? null,
    envelopeIsError: safeBoolean(envelope.isError) ?? null,
    // Body proof cannot excuse changed arguments or other authored tool facts.
    raw: block ? { ...block, isError: safeBoolean(raw?.is_error) ?? safeBoolean(block.isError) } : null,
  };
}

/** Body transformations cannot change tool provenance or same-id occurrence order. */
export function toolProvenanceIdentity(
  parts: readonly Omit<CreateMessagePartInput, "sessionId">[],
): string {
  return JSON.stringify(canonical(parts.map(toolProvenance).filter((value) => value !== null)
    .sort((a, b) => (a.id ?? "").localeCompare(b.id ?? ""))));
}

/** Structured provenance, not the parent's lossy plain-text index key. */
export function structuredPartsIdentity(
  parts: readonly Omit<CreateMessagePartInput, "sessionId">[],
): string | null {
  // String tool results keep provenance only in text-part metadata. Ignoring
  // those fields would let changed tool names or error flags reuse an old row.
  if (!parts.some((part) => {
    return part.partType !== "text" || part.toolCallId || toolProvenance(part) !== null;
  })) return null;
  return JSON.stringify(
    canonical(
      parts.map((part) => {
        // Model bookkeeping is not part of the tool/file payload identity.
        const payloadMetadata = json(stripModelIdentityFromMetadataJson(part.metadata));
        return {
          type: part.partType,
          ordinal: part.ordinal,
          text: part.textContent ?? null,
          id: part.toolCallId ?? null,
          name: part.toolName ?? null,
          input: json(part.toolInput),
          output: json(part.toolOutput),
          metadata: payloadMetadata,
        };
      }),
    ),
  );
}

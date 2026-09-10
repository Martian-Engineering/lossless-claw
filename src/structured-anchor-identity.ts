import type { CreateMessagePartInput } from "./store/conversation-store.js";

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

/** Structured provenance, not the parent's lossy plain-text index key. */
export function structuredPartsIdentity(
  parts: readonly Omit<CreateMessagePartInput, "sessionId">[],
): string | null {
  if (!parts.some((part) => part.partType !== "text" || part.toolCallId)) return null;
  return JSON.stringify(
    canonical(
      parts.map((part) => {
        const metadata = json(part.metadata);
        // Model bookkeeping is not part of the tool/file payload identity.
        let payloadMetadata = metadata;
        if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
          const { modelProvider, modelApi, modelId, ...payload } = metadata as Record<
            string,
            unknown
          >;
          payloadMetadata = payload;
        }
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

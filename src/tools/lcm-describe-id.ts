// Retrieval remains the authority for ID existence; keep this grammar open to
// future lowercase ID formats instead of duplicating today's 16-hex generator.
const LCM_BARE_ID_RE = /^(?:sum|file)_[a-z0-9_-]+$/;
const LCM_ID_TOKEN_RE = /\b(?:sum|file)_[a-z0-9_-]+\b/g;
const LCM_LOOSE_ID_RE = /\b(?:sum|file)_[A-Za-z0-9_-]*\b/i;
const LCM_REFERENCE_RE =
  /^\[LCM (?:Tool Output|File|Raw Payload):\s*((?:sum|file)_[a-z0-9_-]+)(?=\s*[|\]])[^\r\n]*\](?:\r?\n[\s\S]*)?$/;

export type ExtractLcmDescribeIdResult =
  | { ok: true; id: string }
  | { ok: false; error: string; hint?: string };

/**
 * Extract an LCM summary or file ID from either a bare ID or an emitted
 * Lossless reference block. Free-form text and ambiguous bare input fail
 * validation instead of selecting an incidental ID.
 */
export function extractLcmDescribeId(raw: string): ExtractLcmDescribeIdResult {
  const trimmed = raw.trim();
  if (LCM_BARE_ID_RE.test(trimmed)) {
    return validateLcmId(trimmed);
  }

  // The leading ID is the only structural ID in references from large-files.ts.
  // Metadata and summaries may contain ID-like filenames or ordinary prose.
  const referenceId = trimmed.match(LCM_REFERENCE_RE)?.[1];
  if (referenceId) {
    return validateLcmId(referenceId);
  }

  const tokens = trimmed.match(LCM_ID_TOKEN_RE) ?? [];
  if (tokens.length > 1) {
    return {
      ok: false,
      error: `Input contains multiple LCM IDs (${tokens.join(", ")}). Provide a bare ID or a single reference string.`,
    };
  }

  const looseId = trimmed.match(LCM_LOOSE_ID_RE)?.[0];
  if (!looseId) {
    return { ok: false, error: `Not a recognized LCM ID: ${raw}` };
  }
  const validated = validateLcmId(looseId);
  if (!validated.ok) {
    return validated;
  }
  if (looseId !== looseId.toLowerCase()) {
    return {
      ok: false,
      error: `Malformed LCM ID: ${looseId}. IDs must be lowercase and contain only letters, digits, underscores, and hyphens after the prefix.`,
    };
  }
  return {
    ok: false,
    error: `Not a recognized LCM ID format: ${raw}`,
    hint: "Provide a bare ID or a single copied reference string such as [LCM Tool Output: file_xxx | ...].",
  };
}

/** Validate special invalid suffixes after the input grammar has identified an ID. */
function validateLcmId(id: string): ExtractLcmDescribeIdResult {
  const suffix = id.slice(id.indexOf("_") + 1);
  if (suffix.length === 0 || /^0+$/.test(suffix)) {
    return { ok: false, error: `LCM ID cannot be a zero/empty ID: ${id}` };
  }
  return { ok: true, id };
}

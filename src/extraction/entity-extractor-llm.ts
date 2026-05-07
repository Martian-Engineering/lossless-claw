/**
 * Entity extractor LLM adapter — LCM v4.1 cycle-2.
 *
 * Builds the prompt for entity extraction, calls the worker-LLM,
 * parses the JSON response into the {@link ExtractEntities} shape that
 * `runCoreferenceTick` (Group E) expects.
 *
 * Why this is its own module: keeps the prompt + parser logic in one
 * place, separate from the worker-LLM transport (worker-llm.ts) and
 * the worker job loop (entity-coreference.ts). Operator tweaking of
 * the prompt happens here.
 *
 * Prompt contract:
 *   System: "You extract structured entities..."
 *   User: "<leaf content>\n\nReturn JSON: [{surface, entityType}, ...]"
 *   Output: pure JSON array (no markdown fence; we strip if present)
 *
 * Failure modes:
 *   - LLM returns non-JSON → caught, logged, returns []
 *   - LLM returns wrong shape → caught per-entry; valid entries kept
 *   - LLM throws (timeout, auth) → propagated to caller (worker tick)
 *
 * The extractor is INTENTIONALLY conservative: better to extract
 * fewer correct entities than many wrong ones. Operator can tune via
 * the prompt template (eventually moves into lcm_prompt_registry).
 */

import type { LcmDependencies } from "../types.js";
import { createWorkerLlmCall } from "../operator/worker-llm.js";
import type { ExtractEntities, ExtractedEntity } from "./entity-coreference.js";

const ENTITY_EXTRACTION_PROMPT_TEMPLATE = `\
You extract structured named entities from a single conversation leaf.

The leaf content is below. Return ONLY a JSON array (no markdown, no
explanation). Each entry: {"surface": "<text as-it-appears>", "entityType": "<short_snake_case_label>"}.

Entity types should be specific and operator-friendly. Examples:
- "pr_number" for PR/issue references like "PR #71676", "#1234"
- "agent_id" for agent identifiers like "R-23", "agent-5"
- "session_key" for session keys like "agent:main:main"
- "config_flag" for config option names
- "command" for CLI commands like "pnpm build"
- "file_path" for absolute paths
- "person_name" for human names
- "date" for dates / time references

If no entities are present, return []. Be conservative — only extract
things that look like distinct, referenceable identifiers, not normal
prose.

Leaf content (~{{tokenCount}} tokens):
\`\`\`
{{content}}
\`\`\`

JSON output:`;

export interface EntityExtractorLlmConfig {
  deps: LcmDependencies;
  /** Default model. Default 'claude-haiku-4-5' (cheap; entity extraction
   *  is high-volume). */
  model?: string;
  timeoutMs?: number;
}

const DEFAULT_MODEL = "claude-haiku-4-5";

/**
 * Build an `ExtractEntities` callback suitable for
 * `runCoreferenceTick(db, extractor, opts)`.
 */
export function createEntityExtractorLlm(
  config: EntityExtractorLlmConfig,
): ExtractEntities {
  const llmCall = createWorkerLlmCall({
    deps: config.deps,
    defaultModel: config.model ?? DEFAULT_MODEL,
    timeoutMs: config.timeoutMs ?? 30_000,
  });

  return async ({ content }) => {
    // Cap input — per-leaf content can be ~4000 tokens (post A.10 cap).
    // Entity extraction works fine on truncated input; we strip mid-content
    // to avoid blowing token budget.
    const trimmedContent = content.length > 16_000 ? content.slice(0, 16_000) + "…" : content;
    const prompt = ENTITY_EXTRACTION_PROMPT_TEMPLATE
      .replace("{{content}}", trimmedContent)
      .replace("{{tokenCount}}", String(Math.ceil(trimmedContent.length / 4)));

    let response;
    try {
      response = await llmCall({
        model: config.model ?? DEFAULT_MODEL,
        prompt,
        passKind: "single",
        maxOutputTokens: 1024,
      });
    } catch (e) {
      // Re-throw — runCoreferenceTick records this as a queue-item
      // failure and retries on the next tick.
      throw e;
    }

    return parseEntityExtractionResponse(response.output);
  };
}

/**
 * Parse the LLM's JSON response. Tolerant: strips markdown code fences,
 * trims whitespace, and falls back to [] if the output isn't parseable.
 *
 * Per-entry validation: entries missing `surface` or `entityType`,
 * or with non-string values, are dropped silently. Invalid types
 * (containing whitespace / special chars) get normalized to snake_case
 * fallback.
 */
export function parseEntityExtractionResponse(raw: string): ExtractedEntity[] {
  if (!raw || typeof raw !== "string") return [];

  // Strip markdown code fence if present
  let s = raw.trim();
  if (s.startsWith("```")) {
    // Remove opening fence (with optional language tag)
    s = s.replace(/^```(?:json)?\s*\n?/, "");
    // Remove closing fence
    s = s.replace(/\n?```\s*$/, "");
    s = s.trim();
  }

  // Some LLMs wrap with prose despite the prompt — try to find the
  // first valid JSON array
  const arrayStart = s.indexOf("[");
  const arrayEnd = s.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    s = s.slice(arrayStart, arrayEnd + 1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(s);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: ExtractedEntity[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const surface = typeof e.surface === "string" ? e.surface.trim() : "";
    const entityTypeRaw = typeof e.entityType === "string" ? e.entityType.trim() : "";
    if (!surface || !entityTypeRaw) continue;
    // Normalize entityType to snake_case
    const entityType = entityTypeRaw
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "");
    if (!entityType) continue;
    // Optional fields
    const canonicalText =
      typeof e.canonicalText === "string" && e.canonicalText.trim().length > 0
        ? e.canonicalText.trim()
        : undefined;
    out.push({ surface, entityType, canonicalText });
  }
  return out;
}

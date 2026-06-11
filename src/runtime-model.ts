/**
 * Shared extraction of runtime model metadata (provider, model id, and model
 * context-window size) from the untyped runtime-context / legacy-param bags
 * that hosts pass into the engine.
 */
import { safeString } from "./value-utils.js";

export type RuntimeModelContext = {
  provider?: string;
  model?: string;
  /** `provider/model` when the host reports a bare model id plus a provider. */
  modelRef?: string;
  modelContextWindow?: number;
};

// Hosts disagree on the key that carries the model context-window size;
// probe the known spellings in preference order.
const MODEL_CONTEXT_WINDOW_KEYS = [
  "modelContextWindow",
  "modelContextWindowTokens",
  "contextWindow",
  "contextWindowTokens",
  "maxContextTokens",
  "contextWindowMax",
];

const PROVIDER_KEYS = ["provider", "providerId"];
const MODEL_KEYS = ["model", "modelId"];

// Normalize a candidate context-window value to a positive integer.
function toPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return undefined;
  }
  return Math.floor(value);
}

// First non-empty string among the given keys, scanning bags in order.
function firstString(bags: Record<string, unknown>[], keys: string[]): string | undefined {
  for (const bag of bags) {
    for (const key of keys) {
      const value = safeString(bag[key])?.trim();
      if (value) {
        return value;
      }
    }
  }
  return undefined;
}

// First valid context-window value among the known keys, scanning bags in order.
function firstContextWindow(bags: Record<string, unknown>[]): number | undefined {
  for (const bag of bags) {
    for (const key of MODEL_CONTEXT_WINDOW_KEYS) {
      const value = toPositiveInteger(bag[key]);
      if (value !== undefined) {
        return value;
      }
    }
  }
  return undefined;
}

/**
 * Extract provider/model/context-window metadata from host param bags.
 * Earlier bags win, so callers pass the preferred bag first
 * (e.g. runtimeContext before legacy compaction params).
 */
export function readRuntimeModelContext(
  ...bags: Array<Record<string, unknown> | undefined>
): RuntimeModelContext {
  const present = bags.filter((bag): bag is Record<string, unknown> => bag !== undefined);
  const provider = firstString(present, PROVIDER_KEYS);
  const model = firstString(present, MODEL_KEYS);
  const modelRef =
    model && provider && !model.includes("/") ? `${provider}/${model}` : model;
  const modelContextWindow = firstContextWindow(present);

  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(modelRef ? { modelRef } : {}),
    ...(modelContextWindow !== undefined ? { modelContextWindow } : {}),
  };
}

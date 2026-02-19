import type { AnyAgentTool as OpenClawAnyAgentTool } from "openclaw/plugin-sdk";

export type AnyAgentTool = OpenClawAnyAgentTool;

/** Render structured payloads as deterministic text tool results. */
export function jsonResult(payload: unknown): {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
} {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
    details: payload,
  };
}

/** Read a string param with optional trimming/required checks. */
export function readStringParam(
  params: Record<string, unknown>,
  key: string,
  options?: {
    required?: boolean;
    trim?: boolean;
    allowEmpty?: boolean;
    label?: string;
  },
): string | undefined {
  const raw = params[key];
  if (raw == null) {
    if (options?.required) {
      throw new Error(`${options.label ?? key} is required.`);
    }
    return undefined;
  }

  if (typeof raw !== "string") {
    throw new Error(`${options?.label ?? key} must be a string.`);
  }

  const value = options?.trim === false ? raw : raw.trim();
  if (!options?.allowEmpty && value.length === 0) {
    if (options?.required) {
      throw new Error(`${options.label ?? key} is required.`);
    }
    return undefined;
  }

  return value;
}

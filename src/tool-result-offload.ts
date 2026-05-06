export type ToolResultOffloadMeta = {
  fileId: string;
  originalChars: number;
  originalBytes: number;
  previewChars: number;
  strategy: "deterministic_head_tail";
};

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clampPreviewChars(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 1800;
  }
  return Math.max(128, Math.floor(value));
}

function takeHeadTailPreview(text: string, previewChars: number): string {
  const normalized = compactWhitespace(text);
  if (normalized.length <= previewChars) {
    return normalized;
  }

  const head = Math.max(1, Math.floor(previewChars * 0.6));
  const tail = Math.max(1, previewChars - head - 5);
  return `${normalized.slice(0, head)}\n...\n${normalized.slice(-tail)}`;
}

export function buildToolResultPreviewText(params: {
  fileId: string;
  toolName: string;
  originalByteSize: number;
  isError: boolean;
  originalText: string;
  previewChars: number;
}): string {
  const preview = takeHeadTailPreview(params.originalText, clampPreviewChars(params.previewChars));

  return [
    `[LCM Tool Result Offloaded: ${params.fileId} | ${params.toolName} | ${params.originalByteSize.toLocaleString("en-US")} bytes | error=${params.isError}]`,
    "",
    "Preview:",
    preview || "(empty)",
    "",
    `Full output stored as ${params.fileId}.`,
    `Use lcm_describe id="${params.fileId}" for the stored result.`,
  ].join("\n");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sanitizeScalar(value: unknown): string | number | boolean | null | undefined {
  if (value == null) {
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const compact = compactWhitespace(value);
    return compact.length > 0 && compact.length <= 256 ? compact : undefined;
  }
  return undefined;
}

export function sanitizeToolResultDetails(params: {
  toolName: string;
  details: unknown;
  meta: ToolResultOffloadMeta;
}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    lcmOffload: {
      fileId: params.meta.fileId,
      originalChars: params.meta.originalChars,
      originalBytes: params.meta.originalBytes,
      previewChars: params.meta.previewChars,
      strategy: params.meta.strategy,
    },
  };

  if (!isPlainObject(params.details)) {
    return base;
  }

  const details = params.details;

  if (params.toolName === "exec") {
    for (const key of ["status", "exitCode", "durationMs", "cwd"]) {
      const sanitized = sanitizeScalar(details[key]);
      if (sanitized !== undefined) {
        base[key] = sanitized;
      }
    }
    return base;
  }

  for (const [key, value] of Object.entries(details)) {
    if (key === "lcmOffload") {
      continue;
    }

    const sanitized = sanitizeScalar(value);
    if (sanitized !== undefined) {
      base[key] = sanitized;
      continue;
    }

    if (Array.isArray(value)) {
      base[key] = { count: value.length };
      continue;
    }

    if (isPlainObject(value)) {
      base[key] = { keys: Object.keys(value).length };
    }
  }

  return base;
}

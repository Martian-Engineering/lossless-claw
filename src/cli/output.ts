/** Stable process exit codes exposed by the `lcm` executable. */
export type CliExitCode = 1 | 2 | 3 | 4 | 5;

/** Structured CLI failure with a machine-readable code and process exit status. */
export class CliError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly exitCode: CliExitCode,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export type PaginationMetadata = {
  limit: number;
  returned: number;
  hasMore: boolean;
  nextCursor: string | null;
};

export type SuccessEnvelope<TData, TMeta extends Record<string, unknown>> = {
  ok: true;
  command: string;
  data: TData;
  pagination?: PaginationMetadata;
  meta: TMeta;
};

export type ErrorEnvelope = {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

/** Build the stable success envelope used by every JSON command response. */
export function createSuccessEnvelope<TData, TMeta extends Record<string, unknown>>(
  command: string,
  data: TData,
  meta: TMeta,
  pagination?: PaginationMetadata,
): SuccessEnvelope<TData, TMeta> {
  return {
    ok: true,
    command,
    data,
    ...(pagination ? { pagination } : {}),
    meta,
  };
}

/** Build the stable error envelope written to stderr for expected failures. */
export function createErrorEnvelope(error: CliError): ErrorEnvelope {
  return {
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
}

/** Convert an unexpected thrown value into a stable internal CLI error. */
export function normalizeCliError(error: unknown): CliError {
  if (error instanceof CliError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new CliError("INTERNAL_ERROR", message || "Unexpected CLI failure.", 1);
}

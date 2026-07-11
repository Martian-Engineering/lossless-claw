import { parseArgs } from "node:util";
import { CliError } from "./output.js";

export type ConversationSelector =
  | { kind: "conversationId"; value: number }
  | { kind: "sessionKey"; value: string };

export type MessageRole = "system" | "user" | "assistant" | "tool";
export type SummaryKind = "leaf" | "condensed";
export type OutputFormat = "json" | "table";

export type CliCommand =
  | { kind: "help"; topic?: string }
  | { kind: "version" }
  | { kind: "status" }
  | { kind: "conversations.list" }
  | { kind: "conversations.show" }
  | { kind: "messages.list" }
  | { kind: "messages.tail" }
  | { kind: "summaries.list" }
  | { kind: "summaries.show"; summaryId: string }
  | { kind: "config.show" }
  | { kind: "config.get"; path: string }
  | { kind: "config.set"; path: string; value: string }
  | { kind: "doctor" };

export type TimeFilter = {
  after?: Date;
  before?: Date;
};

export type ParsedCliArgs = {
  command: CliCommand;
  databasePath?: string;
  configPath?: string;
  openclawDir?: string;
  format: OutputFormat;
  pretty: boolean;
  selector?: ConversationSelector;
  time: TimeFilter;
  limit: number;
  cursor?: string;
  roles: MessageRole[];
  includeContent: boolean;
  depth?: number;
  summaryKind?: SummaryKind;
  count?: number;
};

export type CursorResource = "conversations" | "messages" | "summaries";
export type DecodedCursor = { timestamp: string; id: number | string };

type TimeFilterInput = {
  after?: string;
  before?: string;
  between?: string;
  recency?: string;
};

const MESSAGE_ROLES = new Set<MessageRole>(["system", "user", "assistant", "tool"]);
const SUMMARY_KINDS = new Set<SummaryKind>(["leaf", "condensed"]);
const FIXED_COMMANDS = new Set([
  "conversations.list",
  "conversations.show",
  "messages.list",
  "messages.tail",
  "summaries.list",
  "config.show",
]);
const ISO_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|([+-])(\d{2}):(\d{2}))$/;
const CLI_OPTIONS = {
  db: { type: "string" },
  config: { type: "string" },
  "openclaw-dir": { type: "string" },
  format: { type: "string", default: "json" },
  pretty: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
  version: { type: "boolean", short: "v", default: false },
  "conversation-id": { type: "string" },
  "session-key": { type: "string" },
  after: { type: "string" },
  before: { type: "string" },
  between: { type: "string" },
  recency: { type: "string" },
  limit: { type: "string" },
  cursor: { type: "string" },
  role: { type: "string", multiple: true },
  "include-content": { type: "boolean", default: false },
  depth: { type: "string" },
  kind: { type: "string" },
  count: { type: "string" },
} as const;

type CommandSpecificOption =
  | "conversation-id"
  | "session-key"
  | "after"
  | "before"
  | "between"
  | "recency"
  | "limit"
  | "cursor"
  | "role"
  | "include-content"
  | "depth"
  | "kind"
  | "count";

const COMMAND_OPTION_SUPPORT: Record<CommandSpecificOption, ReadonlySet<CliCommand["kind"]>> = {
  "conversation-id": new Set(["conversations.show", "messages.list", "messages.tail", "summaries.list"]),
  "session-key": new Set(["conversations.show", "messages.list", "messages.tail", "summaries.list"]),
  after: new Set(["messages.list", "summaries.list"]),
  before: new Set(["messages.list", "summaries.list"]),
  between: new Set(["messages.list", "summaries.list"]),
  recency: new Set(["messages.list", "summaries.list"]),
  limit: new Set(["conversations.list", "messages.list", "summaries.list"]),
  cursor: new Set(["conversations.list", "messages.list", "summaries.list"]),
  role: new Set(["messages.list"]),
  "include-content": new Set(["messages.list", "summaries.list"]),
  depth: new Set(["summaries.list"]),
  kind: new Set(["summaries.list"]),
  count: new Set(["messages.tail"]),
};
const CONFIG_JSON_VALUE_SENTINEL = "\0lcm-config-json-value";

// Parse a bounded positive integer option without accepting coercible strings.
function parsePositiveInteger(value: string | undefined, label: string, maximum?: number): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!/^\d+$/.test(value)) {
    throw new CliError("INVALID_ARGUMENT", `${label} must be a positive integer.`, 2, { value });
  }
  const parsed = Number.parseInt(value, 10);
  if (parsed < 1 || (maximum !== undefined && parsed > maximum)) {
    throw new CliError(
      "INVALID_ARGUMENT",
      `${label} must be between 1 and ${maximum ?? Number.MAX_SAFE_INTEGER}.`,
      2,
      { value },
    );
  }
  return parsed;
}

// Parse a zero-based integer option such as summary depth.
function parseNonNegativeInteger(value: string | undefined, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!/^\d+$/.test(value)) {
    throw new CliError("INVALID_ARGUMENT", `${label} must be a non-negative integer.`, 2, { value });
  }
  return Number.parseInt(value, 10);
}

// Parse one externally supplied timestamp and normalize its validation error.
function parseTimestamp(value: string, label: string): Date {
  const match = value.match(ISO_TIMESTAMP_PATTERN);
  if (!match) {
    throw new CliError("INVALID_TIME_FILTER", `${label} must be an ISO-8601 timestamp.`, 2, { value });
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new CliError("INVALID_TIME_FILTER", `${label} must be an ISO-8601 timestamp.`, 2, { value });
  }

  // Undo the parsed offset, then ensure JavaScript did not normalize an impossible date.
  const offsetSign = match[9] === "-" ? -1 : 1;
  const offsetMinutes = match[8] === "Z"
    ? 0
    : offsetSign * (Number(match[10]) * 60 + Number(match[11]));
  const local = new Date(parsed.getTime() + offsetMinutes * 60_000);
  const expected = match.slice(1, 7).map((part) => Number(part ?? 0));
  const actual = [
    local.getUTCFullYear(),
    local.getUTCMonth() + 1,
    local.getUTCDate(),
    local.getUTCHours(),
    local.getUTCMinutes(),
    local.getUTCSeconds(),
  ];
  if (actual.some((part, index) => part !== expected[index])) {
    throw new CliError("INVALID_TIME_FILTER", `${label} must be a valid calendar timestamp.`, 2, { value });
  }
  return parsed;
}

// Convert the compact CLI duration grammar to milliseconds.
function parseDurationMilliseconds(value: string): number {
  const match = value.match(/^(\d+)([smhdw])$/i);
  if (!match || Number.parseInt(match[1]!, 10) < 1) {
    throw new CliError(
      "INVALID_TIME_FILTER",
      "recency must be a positive integer followed by s, m, h, d, or w.",
      2,
      { value },
    );
  }
  const unitMs = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  return Number.parseInt(match[1]!, 10) * unitMs[match[2]!.toLowerCase() as keyof typeof unitMs];
}

/** Parse and validate inclusive lower and exclusive upper CLI time filters. */
export function parseTimeFilter(input: TimeFilterInput, now: Date = new Date()): TimeFilter {
  if (input.between && (input.after || input.before || input.recency)) {
    throw new CliError(
      "INVALID_TIME_FILTER",
      "between cannot be combined with after, before, or recency.",
      2,
    );
  }
  if (input.after && input.recency) {
    throw new CliError("INVALID_TIME_FILTER", "after cannot be combined with recency.", 2);
  }

  let after = input.after ? parseTimestamp(input.after, "after") : undefined;
  let before = input.before ? parseTimestamp(input.before, "before") : undefined;
  if (input.between) {
    const parts = input.between.split("..");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new CliError("INVALID_TIME_FILTER", "between must use <start>..<end>.", 2);
    }
    after = parseTimestamp(parts[0], "between start");
    before = parseTimestamp(parts[1], "between end");
  } else if (input.recency) {
    after = new Date(now.getTime() - parseDurationMilliseconds(input.recency));
  }

  if (after && before && after.getTime() >= before.getTime()) {
    throw new CliError("INVALID_TIME_FILTER", "The lower time bound must precede the upper bound.", 2);
  }
  return { ...(after ? { after } : {}), ...(before ? { before } : {}) };
}

// Enforce the mutually exclusive conversation selector contract.
function parseSelector(conversationId: string | undefined, sessionKey: string | undefined): ConversationSelector | undefined {
  if (conversationId && sessionKey) {
    throw new CliError("INVALID_SELECTOR", "Use conversation-id or session-key, not both.", 2);
  }
  if (conversationId) {
    const value = parsePositiveInteger(conversationId, "conversation-id");
    return { kind: "conversationId", value: value! };
  }
  const normalizedSessionKey = sessionKey?.trim();
  return normalizedSessionKey ? { kind: "sessionKey", value: normalizedSessionKey } : undefined;
}

// Map positional resource/action words to the public command union.
function parseCommand(positionals: string[], help: boolean, version: boolean): CliCommand {
  if (version) {
    return { kind: "version" };
  }
  if (help || positionals.length === 0) {
    return { kind: "help", ...(positionals.length ? { topic: positionals.join(" ") } : {}) };
  }
  const [resource, action, ...rest] = positionals;
  const key = action ? `${resource}.${action}` : resource;
  if (FIXED_COMMANDS.has(key) && rest.length > 0) {
    throw new CliError("INVALID_COMMAND", `${key} does not accept positional arguments.`, 2);
  }
  switch (key) {
    case "status": return { kind: "status" };
    case "conversations.list": return { kind: "conversations.list" };
    case "conversations.show": return { kind: "conversations.show" };
    case "messages.list": return { kind: "messages.list" };
    case "messages.tail": return { kind: "messages.tail" };
    case "summaries.list": return { kind: "summaries.list" };
    case "summaries.show":
      if (!rest[0] || rest.length !== 1) {
        throw new CliError("INVALID_COMMAND", "summaries show requires one summary id.", 2);
      }
      return { kind: "summaries.show", summaryId: rest[0] };
    case "config.show": return { kind: "config.show" };
    case "config.get":
      if (!rest[0] || rest.length !== 1) {
        throw new CliError("INVALID_COMMAND", "config get requires one config path.", 2);
      }
      return { kind: "config.get", path: rest[0] };
    case "config.set":
      if (!rest[0] || rest[1] === undefined || rest.length !== 2) {
        throw new CliError("INVALID_COMMAND", "config set requires a path and JSON value.", 2);
      }
      return { kind: "config.set", path: rest[0], value: rest[1] };
    case "doctor": return { kind: "doctor" };
    default:
      throw new CliError("INVALID_COMMAND", `Unknown command: ${positionals.join(" ")}.`, 2);
  }
}

// Require scope only for commands whose result cannot be global.
function requireSelector(command: CliCommand, selector: ConversationSelector | undefined): void {
  if (
    !selector
    && ["conversations.show", "messages.list", "messages.tail"].includes(command.kind)
  ) {
    throw new CliError(
      "MISSING_SELECTOR",
      `${command.kind} requires conversation-id or session-key.`,
      2,
    );
  }
}

// Protect one negative JSON number from option parsing when it is the config-set value.
function normalizeDashPrefixedConfigValue(args: string[]): {
  args: string[];
  originalValue?: string;
} {
  for (const [index, originalValue] of args.entries()) {
    try {
      if (!originalValue.startsWith("-") || typeof JSON.parse(originalValue) !== "number") {
        continue;
      }
    } catch {
      continue;
    }

    // Let the strict parser prove that this candidate is the config-set value positional.
    const normalized = [...args];
    normalized[index] = CONFIG_JSON_VALUE_SENTINEL;
    try {
      const inspected = parseArgs({
        args: normalized,
        allowPositionals: true,
        strict: true,
        options: CLI_OPTIONS,
      });
      if (
        inspected.positionals.length === 4
        && inspected.positionals[0] === "config"
        && inspected.positionals[1] === "set"
        && inspected.positionals[3] === CONFIG_JSON_VALUE_SENTINEL
      ) {
        return { args: normalized, originalValue };
      }
    } catch {
      // The normal strict parse below owns the final error for invalid invocations.
    }
  }
  return { args };
}

// Keep Node's option-schema inference intact for the normalized parser below.
function parseRawCliArgs(args: string[]) {
  const normalized = normalizeDashPrefixedConfigValue(args);
  const parsed = parseArgs({
    args: normalized.args,
    allowPositionals: true,
    strict: true,
    options: CLI_OPTIONS,
  });
  if (normalized.originalValue !== undefined) {
    const valueIndex = parsed.positionals.indexOf(CONFIG_JSON_VALUE_SENTINEL);
    if (valueIndex >= 0) {
      parsed.positionals[valueIndex] = normalized.originalValue;
    }
  }
  return parsed;
}

// Reject command-specific options instead of silently returning unfiltered data.
function assertSupportedCommandOptions(
  command: CliCommand,
  values: ReturnType<typeof parseRawCliArgs>["values"],
): void {
  const supplied = (Object.keys(COMMAND_OPTION_SUPPORT) as CommandSpecificOption[])
    .filter((option) => {
      const value = values[option];
      return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== false;
    });
  for (const option of supplied) {
    if (!COMMAND_OPTION_SUPPORT[option].has(command.kind)) {
      throw new CliError(
        "INVALID_ARGUMENT",
        `--${option} is not supported by ${command.kind}.`,
        2,
        { option, command: command.kind },
      );
    }
  }
}

/** Parse one complete `lcm` invocation into a validated command contract. */
export function parseCliArgs(args: string[], now: Date = new Date()): ParsedCliArgs {
  let parsed: ReturnType<typeof parseRawCliArgs>;
  try {
    parsed = parseRawCliArgs(args);
  } catch (error) {
    throw new CliError(
      "INVALID_ARGUMENT",
      error instanceof Error ? error.message : String(error),
      2,
    );
  }

  // Normalize and validate each external option once at the process boundary.
  const command = parseCommand(parsed.positionals, parsed.values.help === true, parsed.values.version === true);
  assertSupportedCommandOptions(command, parsed.values);
  const selector = parseSelector(parsed.values["conversation-id"], parsed.values["session-key"]);
  requireSelector(command, selector);
  const format = parsed.values.format;
  if (format !== "json" && format !== "table") {
    throw new CliError("INVALID_ARGUMENT", "format must be json or table.", 2, { value: format });
  }
  const roleValues = parsed.values.role ?? [];
  const roles = roleValues.map((role) => {
    if (!MESSAGE_ROLES.has(role as MessageRole)) {
      throw new CliError("INVALID_ARGUMENT", `Unsupported message role: ${role}.`, 2);
    }
    return role as MessageRole;
  });
  const summaryKindValue = parsed.values.kind;
  if (summaryKindValue && !SUMMARY_KINDS.has(summaryKindValue as SummaryKind)) {
    throw new CliError("INVALID_ARGUMENT", `Unsupported summary kind: ${summaryKindValue}.`, 2);
  }

  return {
    command,
    databasePath: parsed.values.db,
    configPath: parsed.values.config,
    openclawDir: parsed.values["openclaw-dir"],
    format,
    pretty: parsed.values.pretty === true,
    selector,
    time: parseTimeFilter({
      after: parsed.values.after,
      before: parsed.values.before,
      between: parsed.values.between,
      recency: parsed.values.recency,
    }, now),
    limit: parsePositiveInteger(parsed.values.limit ?? "50", "limit", 500)!,
    cursor: parsed.values.cursor,
    roles,
    includeContent: parsed.values["include-content"] === true,
    depth: parseNonNegativeInteger(parsed.values.depth, "depth"),
    summaryKind: summaryKindValue as SummaryKind | undefined,
    count: parsePositiveInteger(parsed.values.count, "count", 500),
  };
}

/** Encode a stable keyset position as an opaque URL-safe cursor. */
export function encodeCursor(resource: CursorResource, timestamp: string, id: number | string): string {
  return Buffer.from(JSON.stringify({ v: 1, resource, timestamp, id }), "utf8").toString("base64url");
}

/** Decode and validate an opaque cursor for the expected list resource. */
export function decodeCursor(cursor: string, expectedResource: CursorResource): DecodedCursor {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    if (
      value.v !== 1
      || value.resource !== expectedResource
      || typeof value.timestamp !== "string"
      || !Number.isFinite(new Date(value.timestamp).getTime())
      || (typeof value.id !== "string" && typeof value.id !== "number")
    ) {
      throw new Error("cursor shape mismatch");
    }
    return { timestamp: value.timestamp, id: value.id };
  } catch {
    throw new CliError("INVALID_CURSOR", `Invalid ${expectedResource} cursor.`, 2);
  }
}

import { existsSync, statSync } from "node:fs";
import packageJson from "../../package.json" with { type: "json" };
import { parseCliArgs, type ParsedCliArgs } from "./args.js";
import {
  getConfigValue,
  readRawLosslessConfig,
  readConfigView,
  setConfigValue,
  type ConfigView,
} from "./config-file.js";
import { openReadOnlyDatabase } from "./database.js";
import {
  CliError,
  createErrorEnvelope,
  createSuccessEnvelope,
  normalizeCliError,
  renderSuccessEnvelope,
  type PaginationMetadata,
} from "./output.js";
import { resolveCliPaths, type ResolvedCliPaths } from "./paths.js";
import {
  getConversationDiagnostics,
  getFreshTail,
  getGlobalStatus,
  getSummaryDetails,
  listConversations,
  listMessages,
  listSummaries,
} from "./queries.js";
import { resolveLcmConfigWithDiagnostics } from "../db/config.js";

type CliIo = {
  env?: NodeJS.ProcessEnv;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
};

type CommandResult = {
  data: unknown;
  pagination?: PaginationMetadata;
};

type InvocationContext = {
  paths: ResolvedCliPaths;
  config: ConfigView;
};

type ConfigSetCommand = Extract<ParsedCliArgs["command"], { kind: "config.set" }>;

const HELP_DATA = {
  usage: "lcm <command> [options]",
  commands: [
    "status",
    "conversations list",
    "conversations show (--conversation-id <id> | --session-key <key>)",
    "messages list (--conversation-id <id> | --session-key <key>)",
    "messages tail (--conversation-id <id> | --session-key <key>)",
    "summaries list [--conversation-id <id> | --session-key <key>]",
    "summaries show <summary-id>",
    "config show",
    "config get <path>",
    "config set <path> <json-value>",
    "doctor",
  ],
  globalOptions: [
    "--db <path>",
    "--config <path>",
    "--openclaw-dir <path>",
    "--format <json|table>",
    "--pretty",
    "--help",
    "--version",
  ],
  listOptions: ["--limit <1..500>", "--cursor <opaque-cursor>"],
  selectorOptions: ["--conversation-id <id>", "--session-key <key>"],
  messageOptions: ["--role <role>", "--include-content"],
  summaryOptions: ["--depth <integer>", "--kind <leaf|condensed>", "--include-content"],
  tailOptions: ["--count <1..500>"],
  timeOptions: [
    "--after <iso-timestamp>",
    "--before <iso-timestamp>",
    "--between <start>..<end>",
    "--recency <duration: s|m|h|d|w>",
  ],
} as const;

// Build a default config view when the OpenClaw config file has not been created.
function loadConfigView(configPath: string, env: NodeJS.ProcessEnv): ConfigView {
  if (existsSync(configPath)) {
    return readConfigView(configPath, env);
  }
  const resolved = resolveLcmConfigWithDiagnostics(env, {});
  return {
    configPath,
    raw: {},
    effective: resolved.config,
    diagnostics: resolved.diagnostics,
    environmentOverrides: Object.keys(env)
      .filter((key) => (key.startsWith("LCM_") || key === "TZ") && env[key] !== undefined)
      .sort(),
  };
}

// Collect explicit path flags once for config and database discovery.
function pathOverrides(parsed: ParsedCliArgs) {
  return {
    openclawDir: parsed.openclawDir,
    configPath: parsed.configPath,
    databasePath: parsed.databasePath,
  };
}

// Resolve config first, then allow its databasePath/dbPath to participate in DB discovery.
function resolveInvocationContext(parsed: ParsedCliArgs, env: NodeJS.ProcessEnv): InvocationContext {
  const overrides = pathOverrides(parsed);
  const basePaths = resolveCliPaths({ env, overrides });
  const configEnv = { ...env, OPENCLAW_STATE_DIR: basePaths.openclawDir };
  const config = loadConfigView(basePaths.configPath, configEnv);
  const paths = resolveCliPaths({ env, overrides, pluginConfig: config.raw });
  return { paths, config };
}

// Apply a targeted repair before loading the effective config, then resolve updated paths.
function runConfigSetCommand(
  parsed: ParsedCliArgs,
  command: ConfigSetCommand,
  env: NodeJS.ProcessEnv,
): { paths: ResolvedCliPaths; result: CommandResult } {
  const overrides = pathOverrides(parsed);
  const basePaths = resolveCliPaths({ env, overrides });
  const data = setConfigValue(basePaths.configPath, command.path, command.value);
  const raw = readRawLosslessConfig(basePaths.configPath);
  const paths = resolveCliPaths({ env, overrides, pluginConfig: raw });
  return { paths, result: { data } };
}

// Dispatch commands that inspect config without opening the database.
function runConfigCommand(parsed: ParsedCliArgs, config: ConfigView): CommandResult | null {
  switch (parsed.command.kind) {
    case "config.show":
      return { data: config };
    case "config.get":
      return { data: getConfigValue(config, parsed.command.path) };
    default:
      return null;
  }
}

// Dispatch every command that reads the LCM database through one read-only handle.
function runDatabaseCommand(
  parsed: ParsedCliArgs,
  paths: ResolvedCliPaths,
  config: ConfigView,
): CommandResult {
  const db = openReadOnlyDatabase(paths.databasePath);
  try {
    switch (parsed.command.kind) {
      case "status":
        return {
          data: {
            version: packageJson.version,
            databaseSizeBytes: statSync(paths.databasePath).size,
            freshTail: {
              count: config.effective.freshTailCount,
              maxTokens: config.effective.freshTailMaxTokens ?? null,
            },
            status: getGlobalStatus(db),
          },
        };
      case "conversations.list": {
        const page = listConversations(db, {
          limit: parsed.limit,
          cursor: parsed.cursor,
          freshTailCount: config.effective.freshTailCount,
          freshTailMaxTokens: config.effective.freshTailMaxTokens,
        });
        return { data: { items: page.items }, pagination: page.pagination };
      }
      case "conversations.show":
        return {
          data: getConversationDiagnostics(db, parsed.selector!, {
            freshTailCount: config.effective.freshTailCount,
            freshTailMaxTokens: config.effective.freshTailMaxTokens,
          }),
        };
      case "messages.list": {
        const page = listMessages(db, {
          selector: parsed.selector!,
          roles: parsed.roles,
          time: parsed.time,
          limit: parsed.limit,
          cursor: parsed.cursor,
          includeContent: parsed.includeContent,
        });
        return {
          data: { conversation: page.conversation, items: page.items },
          pagination: page.pagination,
        };
      }
      case "messages.tail":
        return {
          data: getFreshTail(db, {
            selector: parsed.selector!,
            freshTailCount: config.effective.freshTailCount,
            freshTailMaxTokens: config.effective.freshTailMaxTokens,
            count: parsed.count,
          }),
        };
      case "summaries.list": {
        const page = listSummaries(db, {
          selector: parsed.selector,
          depth: parsed.depth,
          kind: parsed.summaryKind,
          time: parsed.time,
          limit: parsed.limit,
          cursor: parsed.cursor,
          includeContent: parsed.includeContent,
        });
        return {
          data: { conversationId: page.conversationId, items: page.items },
          pagination: page.pagination,
        };
      }
      case "summaries.show":
        return { data: getSummaryDetails(db, parsed.command.summaryId) };
      default:
        throw new CliError("INVALID_COMMAND", `Command ${parsed.command.kind} does not read the database.`, 2);
    }
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    throw new CliError(
      "DATABASE_QUERY_FAILED",
      `LCM database query failed: ${error instanceof Error ? error.message : String(error)}`,
      5,
      { databasePath: paths.databasePath },
    );
  } finally {
    db.close();
  }
}

/** Execute one `lcm` invocation and return its stable process exit code. */
export function runCli(args: string[], io: CliIo = {}): number {
  const env = io.env ?? process.env;
  const writeStdout = io.stdout ?? ((text: string) => process.stdout.write(text));
  const writeStderr = io.stderr ?? ((text: string) => process.stderr.write(text));
  let parsed: ParsedCliArgs | undefined;
  try {
    parsed = parseCliArgs(args);
    if (parsed.command.kind === "help") {
      const envelope = createSuccessEnvelope("help", {
        ...HELP_DATA,
        ...(parsed.command.topic ? { topic: parsed.command.topic } : {}),
      }, {});
      writeStdout(renderSuccessEnvelope(envelope, parsed.format, parsed.pretty));
      return 0;
    }
    if (parsed.command.kind === "version") {
      const envelope = createSuccessEnvelope("version", { version: packageJson.version }, {});
      writeStdout(renderSuccessEnvelope(envelope, parsed.format, parsed.pretty));
      return 0;
    }
    if (parsed.command.kind === "doctor") {
      const envelope = createSuccessEnvelope("doctor", {
        available: false,
        databaseReadOnly: true,
        message: "Doctor subcommands require a separate approved diagnostic contract.",
      }, {});
      writeStdout(renderSuccessEnvelope(envelope, parsed.format, parsed.pretty));
      return 0;
    }

    let paths: ResolvedCliPaths;
    let result: CommandResult;
    if (parsed.command.kind === "config.set") {
      ({ paths, result } = runConfigSetCommand(parsed, parsed.command, env));
    } else {
      // Config discovery precedes database discovery so configured DB aliases take effect.
      const context = resolveInvocationContext(parsed, env);
      paths = context.paths;
      result = runConfigCommand(parsed, context.config)
        ?? runDatabaseCommand(parsed, context.paths, context.config);
    }
    const envelope = createSuccessEnvelope(
      parsed.command.kind,
      result.data,
      { databasePath: paths.databasePath, configPath: paths.configPath },
      result.pagination,
    );
    writeStdout(renderSuccessEnvelope(envelope, parsed.format, parsed.pretty));
    return 0;
  } catch (error) {
    const cliError = normalizeCliError(error);
    writeStderr(`${JSON.stringify(createErrorEnvelope(cliError), null, parsed?.pretty ? 2 : undefined)}\n`);
    return cliError.exitCode;
  }
}

#!/usr/bin/env node
import { defaultDbPath, defaultStateDir, runSessionMigration, type SessionMigrationOptions } from "../migrate-sessions.js";

type CliOptions = SessionMigrationOptions & {
  json?: boolean;
  help?: boolean;
};

function usage(): string {
  return [
    "Usage: lossless-claw-migrate-sessions [options]",
    "",
    "Backfill OpenClaw JSONL session files into lcm.db. Dry-run by default.",
    "",
    "Options:",
    "  --source-format <format> Source format: openclaw (default) or codex",
    "  --db <path>             Database path (default: ${OPENCLAW_STATE_DIR:-~/.openclaw}/lcm.db)",
    "  --state-dir <path>      OpenClaw state dir (default: ${OPENCLAW_STATE_DIR:-~/.openclaw})",
    "  --sessions-dir <path>   Directory containing *.jsonl sessions; repeatable",
    "  --file <path>           Import one JSONL file; repeatable",
    "  --session-id <id>       Explicit OpenClaw destination session id (Codex only)",
    "  --session-key <key>     Explicit OpenClaw destination session key (Codex only)",
    "  --apply                 Write changes after creating a database backup",
    "  --limit <n>             Limit scanned files",
    "  --since <iso-date>      Include files modified at/after the date",
    "  --json                  Print machine-readable JSON",
    "  --verbose               Print per-file warnings",
    "  -h, --help              Show this help",
  ].join("\n");
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    sessionDirs: [],
    files: [],
  };
  for (let idx = 0; idx < argv.length; idx++) {
    const arg = argv[idx];
    switch (arg) {
      case "--source-format": {
        const value = requireValue(argv, idx, arg);
        if (value !== "openclaw" && value !== "codex") {
          throw new Error("--source-format must be openclaw or codex.");
        }
        options.sourceFormat = value;
        idx += 1;
        break;
      }
      case "--db":
        options.dbPath = requireValue(argv, idx, arg);
        idx += 1;
        break;
      case "--state-dir":
        options.stateDir = requireValue(argv, idx, arg);
        idx += 1;
        break;
      case "--sessions-dir":
        options.sessionDirs!.push(requireValue(argv, idx, arg));
        idx += 1;
        break;
      case "--file":
        options.files!.push(requireValue(argv, idx, arg));
        idx += 1;
        break;
      case "--session-id":
        options.sessionId = requireValue(argv, idx, arg);
        idx += 1;
        break;
      case "--session-key":
        options.sessionKey = requireValue(argv, idx, arg);
        idx += 1;
        break;
      case "--apply":
        options.apply = true;
        break;
      case "--limit": {
        const value = Number(requireValue(argv, idx, arg));
        if (!Number.isInteger(value) || value < 0) {
          throw new Error("--limit must be a non-negative integer.");
        }
        options.limit = value;
        idx += 1;
        break;
      }
      case "--since":
        options.since = requireValue(argv, idx, arg);
        idx += 1;
        break;
      case "--json":
        options.json = true;
        break;
      case "--verbose":
        options.verbose = true;
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (options.sessionDirs?.length === 0) {
    delete options.sessionDirs;
  }
  if (options.files?.length === 0) {
    delete options.files;
  }
  if (options.sourceFormat === "codex") {
    if ((options.files?.length ?? 0) !== 1 || (options.sessionDirs?.length ?? 0) > 0) {
      throw new Error("Codex import requires exactly one --file and does not accept --sessions-dir.");
    }
    if (!options.sessionId?.trim() || !options.sessionKey?.trim()) {
      throw new Error("Codex import requires --session-id and --session-key.");
    }
  }
  return options;
}

function formatHumanSummary(result: Awaited<ReturnType<typeof runSessionMigration>>, verbose = false): string {
  const mode = result.apply ? "apply" : "dry-run";
  const lines = [
    `lossless-claw-migrate-sessions ${mode}`,
    `state dir: ${result.stateDir}`,
    `database: ${result.dbPath}`,
  ];
  if (result.backupPath) {
    lines.push(`backup: ${result.backupPath}`);
  } else if (result.apply) {
    lines.push("backup: skipped (database did not exist yet)");
  }
  lines.push(
    `files: ${result.scannedFiles} scanned, ${result.importedFiles} imported, ${result.skippedFiles} skipped, ${result.errorFiles} errors`,
    `messages: ${result.importedMessages} imported`,
  );
  if (!result.apply) {
    lines.push("dry-run only; rerun with --apply to write changes");
  }

  const notableFiles = verbose
    ? result.files
    : result.files.filter((file) => file.status === "error" || file.status === "skipped" || file.warnings.length > 0);
  for (const file of notableFiles) {
    const reason = file.reason ? ` (${file.reason})` : "";
    lines.push(`- ${file.status}${reason}: ${file.file}`);
    for (const warning of file.warnings) {
      lines.push(`  warning: ${warning}`);
    }
    if (file.error) {
      lines.push(`  error: ${file.error}`);
    }
  }

  return lines.join("\n");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const stateDir = options.stateDir ?? defaultStateDir();
  const dbPath = options.dbPath ?? defaultDbPath(stateDir);
  const result = await runSessionMigration({ ...options, stateDir, dbPath });
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatHumanSummary(result, options.verbose));
  }
  if (result.errorFiles > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

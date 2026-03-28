#!/usr/bin/env node
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { formatListTable, listConversations, parseListOptions, resolveDbPath } from "./lcm-read-list.js";

export interface CliIo {
  stdout: (message: string) => void;
  stderr: (message: string) => void;
}

const defaultIo: CliIo = {
  stdout: (message: string) => {
    process.stdout.write(`${message}\n`);
  },
  stderr: (message: string) => {
    process.stderr.write(`${message}\n`);
  },
};

function printUsage(io: CliIo): void {
  io.stdout(`Usage:
  lcm-read list [options]

Commands:
  list                    List conversations with filters and pagination
  messages                Reserved for STORY-2

List options:
  --db <path>             Path to LCM database (default: ~/.openclaw/lcm.db)
  --agent <scope>         Filter by agent scope
  --provider <type>       Filter by provider
  --since <iso>           Include conversations with messages at or after timestamp
  --before <iso>          Include conversations with messages before timestamp
  --min-messages <n>      Minimum message count (default: 1)
  --sort <field>          Sort by latest, earliest, or messages (default: latest)
  --limit <n>             Max results (default: 50)
  --offset <n>            Pagination offset (default: 0)
  --json                  Output JSON`);
}

function ensureDbExists(dbPath: string): void {
  if (dbPath === ":memory:") {
    return;
  }
  if (!existsSync(dbPath)) {
    throw new Error(`Database not found: ${dbPath}`);
  }
}

export function runLcmReadCli(argv: string[], io: CliIo = defaultIo): number {
  const [command, ...rest] = argv;

  if (!command || command === "--help" || command === "-h") {
    printUsage(io);
    return 0;
  }

  if (command === "list") {
    const options = parseListOptions(rest);
    const dbPath = resolveDbPath(options.dbPath);
    ensureDbExists(dbPath);
    const db = new DatabaseSync(dbPath, { readOnly: true });

    try {
      const result = listConversations(db, { ...options, dbPath });
      if (options.json) {
        io.stdout(JSON.stringify(result.conversations, null, 2));
      } else {
        io.stdout(formatListTable(result));
      }
      return 0;
    } finally {
      db.close();
    }
  }

  if (command === "messages") {
    io.stderr("The messages subcommand is not implemented yet (planned for STORY-2).");
    return 1;
  }

  throw new Error(`Unknown command: ${command}`);
}

function main(): void {
  try {
    const code = runLcmReadCli(process.argv.slice(2));
    process.exitCode = code;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    defaultIo.stderr(`lcm-read: ${message}`);
    process.exitCode = 1;
  }
}

const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entryUrl) {
  main();
}

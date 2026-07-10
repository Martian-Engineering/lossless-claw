import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { CliError } from "./output.js";

const require = createRequire(import.meta.url);

/** Open an existing LCM database through a handle that cannot perform writes. */
export function openReadOnlyDatabase(databasePath: string): DatabaseSync {
  if (!existsSync(databasePath) || !statSync(databasePath).isFile()) {
    throw new CliError(
      "DATABASE_NOT_FOUND",
      `LCM database not found at ${databasePath}.`,
      3,
      { databasePath },
    );
  }

  let database: DatabaseSync | undefined;
  try {
    // Load node:sqlite only for database commands so help/config commands stay warning-free on Node 22.
    const sqlite = require("node:sqlite") as typeof import("node:sqlite");
    const { DatabaseSync } = sqlite;
    database = new DatabaseSync(databasePath, { readOnly: true });
    database.exec("PRAGMA query_only = ON");
  } catch (error) {
    database?.close();
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(
      "DATABASE_OPEN_FAILED",
      `Could not open LCM database: ${message}`,
      5,
      { databasePath },
    );
  }
  return database;
}

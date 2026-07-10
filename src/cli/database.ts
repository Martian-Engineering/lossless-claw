import { existsSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { CliError } from "./output.js";

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

  let database: DatabaseSync;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    database.exec("PRAGMA query_only = ON");
  } catch (error) {
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

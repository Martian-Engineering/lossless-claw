#!/usr/bin/env node
import { readFileSync, writeFileSync, statSync } from "node:fs";
import {
  createLcmDatabaseConnection,
  closeLcmConnection,
} from "../db/connection.js";
import { planRepair, applyRepair, undoRepair } from "../gap-repair.js";

// Separate explicit maintenance surface; never opens/migrates a missing database.
const [action, path, input, output, ...extra] = process.argv.slice(2);
if (
  !["plan", "apply", "undo"].includes(action) ||
  !path ||
  !input ||
  !output ||
  extra.length
) {
  console.error(
    "Usage: lcm-gap-repair <plan|apply|undo> <existing-db> <evidence.json|plan.json|plan-id> <new-output.json>"
  );
  process.exitCode = 2;
} else {
  let db;
  try {
    if (!statSync(path).isFile()) throw new Error("Existing database required");
    // Reserve owner-only output before a mutation, so an existing receipt cannot be overwritten.
    writeFileSync(output, "", { mode: 0o600, flag: "wx" });
    db = createLcmDatabaseConnection(path, { maintenance: true });
    const result =
      action === "plan"
        ? planRepair(db, JSON.parse(readFileSync(input, "utf8")))
        : action === "apply"
        ? await applyRepair(db, JSON.parse(readFileSync(input, "utf8")))
        : undoRepair(db, input);
    writeFileSync(output, JSON.stringify(result, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ action, output, ok: true }));
  } catch (error) {
    // Source payloads/SQL bound values must not be reflected into shared logs.
    console.error(
      "Gap repair failed; inspect protected inputs and audit state before retrying."
    );
    process.exitCode = 1;
  } finally {
    if (db) closeLcmConnection(db);
  }
}

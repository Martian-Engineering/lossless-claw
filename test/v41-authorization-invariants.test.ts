/**
 * Authorization invariant test layer.
 *
 * # Why this exists
 *
 * Wave-9 P0 was a missing `senderIsOwner` gate on
 * `/lcm reconcile-session-keys --apply`. Wave-7 P0-1 had added the gate
 * to `/lcm purge` but didn't extend it to the SISTER destructive commands.
 * No test broke because tests asserted "this case has the gate" — not
 * "every destructive case has the gate." Two waves later, an Opus
 * adversarial agent caught the asymmetry.
 *
 * This test fixes the pattern: it enumerates EVERY operator command
 * case and asserts each is in either the DESTRUCTIVE list (gate
 * required) or the READ_ONLY list (no gate). Adding a new case without
 * classifying it makes the test fail, forcing the maintainer to make
 * an explicit decision.
 *
 * For each DESTRUCTIVE case, the test then invokes it with
 * `senderIsOwner: false` and asserts the response says "operator-only"
 * + "owner privileges". This pins the gate behavior so refactoring
 * one case can't silently disable the gate.
 *
 * # When this test fails
 *
 *   1. New `case "..."` in lcm-command.ts not in either list:
 *      → add to DESTRUCTIVE_OPERATOR_CASES or READ_ONLY_OPERATOR_CASES
 *   2. A destructive case removes its gate:
 *      → that's the bug; restore the gate (don't update the test)
 *   3. lcm-command.ts is refactored to a different shape:
 *      → update the case-extraction regex below
 */

import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeLcmConnection,
  createLcmDatabaseConnection,
} from "../src/db/connection.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { getLcmDbFeatures } from "../src/db/features.js";
import { resolveLcmConfig } from "../src/db/config.js";
import { createLcmCommand } from "../src/plugin/lcm-command.js";

// ────────────────────────────────────────────────────────────────────
// THE LISTS — explicit categorization of every operator command case
// ────────────────────────────────────────────────────────────────────

/**
 * Destructive operator cases. Each REQUIRES a `senderIsOwner` gate.
 *
 * Add to this list when introducing a new destructive case. Removing
 * a case from this list (without removing its gate) breaks the
 * invariant — failure tells you to re-add the gate or move the case
 * to READ_ONLY_OPERATOR_CASES with justification.
 *
 * Each entry is `[caseName, sampleArgs]` where `sampleArgs` invokes the
 * case with realistic-enough arguments to hit the gate (rather than
 * being rejected at parse time).
 */
const DESTRUCTIVE_OPERATOR_CASES: Array<[string, string]> = [
  // Wave-7 P0-1 fixed (originally gated)
  ["purge", "purge --reason test --session-key sk1"],
  // Wave-9 Agent #10 P0 fix (gates this case)
  [
    "reconcile_session_keys_apply",
    "reconcile-session-keys --apply --from legacy:conv_1 --to agent:main:main --reason test",
  ],
  // Wave-9 Agent #10 P1 fix (gates this case)
  ["worker_tick_backfill", "worker tick embedding-backfill"],
];

/**
 * Read-only operator cases — explicitly NOT gated by senderIsOwner.
 * Reading is open so misconfigured non-owner sessions can still
 * introspect system state.
 *
 * If you classify a case as read-only here, it must NOT mutate any
 * persistent state or burn external API quota. (Calling Voyage costs
 * money — that's NOT read-only even if no DB row changes.)
 */
const READ_ONLY_OPERATOR_CASES: ReadonlySet<string> = new Set([
  "status",
  "help",
  "health",
  "worker_status",
  "doctor",
  "doctor_cleaners",
  "reconcile_session_keys_list",
  "eval",
  // backup creates a .bak file (no DB mutation, low-risk; left ungated
  // intentionally — operator can take a snapshot anytime).
  "backup",
  // rotate replaces session storage but is meant to be operator-self-
  // service for "start fresh." Currently ungated; if this changes,
  // move to DESTRUCTIVE_OPERATOR_CASES and add a gate.
  "rotate",
]);

// ────────────────────────────────────────────────────────────────────
// Static analysis: extract case names from lcm-command.ts at test time
// ────────────────────────────────────────────────────────────────────

/**
 * Read lcm-command.ts and extract every `case "<name>":` from the
 * subcommand-handler switch. We scope by finding the comment marker
 * "// Subcommand handlers" or by matching the indentation pattern
 * specific to the handler block — to avoid picking up case statements
 * elsewhere (e.g., parser).
 *
 * The simplest signal: the handler-switch cases all have an indent of
 * exactly 8 spaces and appear after the parser switch (which is at the
 * top of the file). We extract all `case "<name>":` patterns matching
 * that indent.
 */
function extractCommandCases(): string[] {
  const path = "/tmp/lossless-claw-upstream/src/plugin/lcm-command.ts";
  if (!existsSync(path)) {
    throw new Error(`lcm-command.ts not found at ${path}`);
  }
  const source = readFileSync(path, "utf8");
  // Regex captures `        case "X":` (exactly 8 spaces then `case "..."`).
  const re = /^ {8}case "([a-z_]+)":/gm;
  const cases = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    cases.add(m[1]!);
  }
  return [...cases];
}

// ────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────

describe("authorization invariants", () => {
  const tempDirs = new Set<string>();
  const dbPaths = new Set<string>();

  afterEach(() => {
    for (const dbPath of dbPaths) {
      closeLcmConnection(dbPath);
    }
    dbPaths.clear();
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.clear();
  });

  function createCommandFixture() {
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-auth-invariants-"));
    const dbPath = join(tempDir, "lcm.db");
    const db = createLcmDatabaseConnection(dbPath);
    const { fts5Available } = getLcmDbFeatures(db);
    runLcmMigrations(db, { fts5Available });
    const config = resolveLcmConfig({}, { dbPath });
    const command = createLcmCommand({ db, config });
    tempDirs.add(tempDir);
    dbPaths.add(dbPath);
    return command;
  }

  function createCommandContext(args: string, senderIsOwner: boolean) {
    return {
      channel: "telegram",
      isAuthorizedSender: true,
      senderIsOwner,
      commandBody: `/lossless ${args}`,
      args,
      config: {
        plugins: {
          entries: { "lossless-claw": { enabled: true } },
          slots: { contextEngine: "lossless-claw" },
        },
      },
      requestConversationBinding: async () => ({
        status: "error" as const,
        message: "unsupported",
      }),
      detachConversationBinding: async () => ({ removed: false }),
      getCurrentConversationBinding: async () => null,
    };
  }

  it("INVARIANT: every operator command case is classified as destructive or read-only", () => {
    // This is the meta-invariant. If a contributor adds a new case to
    // lcm-command.ts without updating either list, this test fails.
    // That's the desired forcing function.
    const declaredCases = extractCommandCases();
    const classified = new Set([
      ...DESTRUCTIVE_OPERATOR_CASES.map(([name]) => name),
      ...READ_ONLY_OPERATOR_CASES,
    ]);
    const unclassified = declaredCases.filter((c) => !classified.has(c));
    expect(unclassified).toEqual([]);
    // Sanity: lists are non-empty (catch refactor-broken regex).
    expect(declaredCases.length).toBeGreaterThan(0);
  });

  it("INVARIANT: every destructive case rejects non-owner sender", async () => {
    // This is the test that would have caught Wave-9 P0 the moment
    // Wave-7 introduced the asymmetry. For each destructive case,
    // invoke with senderIsOwner=false and assert the response says
    // "operator-only" + "owner privileges".
    const command = createCommandFixture();

    for (const [caseName, args] of DESTRUCTIVE_OPERATOR_CASES) {
      const ctx = createCommandContext(args, false);
      const result = await command.handler(ctx);
      expect(result, `case "${caseName}" returned no result`).toBeDefined();
      const text = (result as { text: string }).text;
      // Both phrases together identify the gate uniquely.
      expect(
        text,
        `case "${caseName}" did NOT reject non-owner — gate is missing`,
      ).toMatch(/operator-only/i);
      expect(
        text,
        `case "${caseName}" did NOT reject non-owner — gate is missing`,
      ).toMatch(/owner privileges/i);
    }
  });

  it("INVARIANT: read-only case 'worker status' is NOT gated (proves test is exercising the gate)", async () => {
    // Sanity check: a read-only case should pass through without the
    // operator-only message. If this test broke (showed operator-only
    // on a read case), the previous test is meaningless because we're
    // matching on a string that's always present.
    const command = createCommandFixture();
    const ctx = createCommandContext("worker status", false);
    const result = await command.handler(ctx);
    const text = (result as { text: string }).text;
    expect(text).not.toMatch(/operator-only/i);
  });
});

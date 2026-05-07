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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
  // Wave-10 reviewer P1 fix: eval mutates lcm_eval_run + lcm_eval_query_result
  // tables AND may cost Voyage tokens in hybrid mode. Was previously classified
  // as READ_ONLY in Wave-9 but reviewer correctly challenged that.
  ["eval", "eval --baseline"],
  // Wave-12 reviewer P1 fix: doctor_cleaners read-only path leaked
  // session_keys + first-message previews to non-owner. Now gates the
  // whole case (was gating only --apply). Sample uses bare `doctor clean`
  // (no --apply) to assert gate fires on the read-only path too.
  ["doctor_cleaners", "doctor clean"],
];

// Wave-11 reviewer P1: doctor + doctor_cleaners are READ_ONLY at the
// case level (the parser dispatches to the same case for both `--apply`
// and the read-only variant). The gate fires on the parsed `apply`
// flag inside the case body, not via the case classification. So the
// case stays in READ_ONLY_OPERATOR_CASES below, but we add a separate
// invariant test below for the apply-flag gate.

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
  // NOTE: doctor_cleaners moved to DESTRUCTIVE_OPERATOR_CASES in Wave-12
  // because both read-only and apply paths leak session metadata.
  "reconcile_session_keys_list",
  // NOTE: `eval` was previously in this set AND in DESTRUCTIVE_OPERATOR_CASES.
  // Wave-10 reviewer correctly classified it as destructive (mutates eval
  // tables + costs Voyage tokens). The set-union check at "every case is
  // classified" silently accepted the duplicate. Removed from read-only here;
  // a new invariant below catches future double-classification.
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
// Wave-11 reviewer P1 fix: previously hardcoded `/tmp/lossless-claw-upstream`
// which broke CI (the path doesn't exist on GitHub runners) and made local
// runs accidentally succeed by reading whatever stale checkout happened to
// be at that path. Now we resolve relative to this test file's location:
// __dirname/../src/plugin/lcm-command.ts. Works in CI, local checkouts at
// any path, and any worktree.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const LCM_COMMAND_PATH = resolve(__dirname, "..", "src", "plugin", "lcm-command.ts");

function extractCommandCases(): string[] {
  if (!existsSync(LCM_COMMAND_PATH)) {
    throw new Error(`lcm-command.ts not found at ${LCM_COMMAND_PATH}`);
  }
  const source = readFileSync(LCM_COMMAND_PATH, "utf8");
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

  it("INVARIANT: no case is classified as both destructive and read-only", () => {
    // Set-union in the previous test silently accepts a case that appears
    // in both sets — e.g., Wave-10 reviewer caught `eval` in both lists.
    // This invariant fails loudly so the duplicate is impossible to miss.
    const destructiveNames = new Set(DESTRUCTIVE_OPERATOR_CASES.map(([n]) => n));
    const dupes = [...READ_ONLY_OPERATOR_CASES].filter((n) => destructiveNames.has(n));
    expect(dupes, `cases classified BOTH destructive and read-only: ${dupes.join(", ")}`).toEqual(
      [],
    );
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

  // ────────────────────────────────────────────────────────────────────
  // Wave-11 reviewer P1: doctor + doctor_cleaners with --apply flag
  // ────────────────────────────────────────────────────────────────────

  it("INVARIANT: /lcm doctor apply rejects non-owner (Wave-11 reviewer P1)", async () => {
    const command = createCommandFixture();
    const ctx = createCommandContext("doctor apply", false);
    const result = await command.handler(ctx);
    expect(result).toBeDefined();
    const text = (result as { text: string }).text;
    expect(text).toMatch(/operator-only/i);
    expect(text).toMatch(/owner privileges/i);
  });

  it("INVARIANT: /lcm doctor clean apply rejects non-owner (Wave-11 reviewer P1)", async () => {
    const command = createCommandFixture();
    const ctx = createCommandContext("doctor clean apply", false);
    const result = await command.handler(ctx);
    expect(result).toBeDefined();
    const text = (result as { text: string }).text;
    expect(text).toMatch(/operator-only/i);
    expect(text).toMatch(/owner privileges/i);
  });

  it("INVARIANT: /lcm doctor (read-only, no --apply) is NOT gated", async () => {
    const command = createCommandFixture();
    const ctx = createCommandContext("doctor", false);
    const result = await command.handler(ctx);
    const text = (result as { text: string }).text;
    // Read-only doctor scan should NOT show operator-only rejection.
    expect(text).not.toMatch(/operator-only/i);
  });

  it("INVARIANT: /lcm doctor clean (read-only, no --apply) IS gated for non-owner (Wave-12 reviewer P1)", async () => {
    // Was previously read-only-open. Reviewer found it leaks session_keys
    // + first-message previews across the global conversation set; now
    // both read and apply paths require senderIsOwner.
    const command = createCommandFixture();
    const ctx = createCommandContext("doctor clean", false);
    const result = await command.handler(ctx);
    const text = (result as { text: string }).text;
    expect(text).toMatch(/operator-only/i);
    expect(text).toMatch(/owner privileges/i);
  });

  it("INVARIANT: /lcm doctor clean (read-only) returns clean output for owner", async () => {
    // Sanity check: owner is NOT gated — the read path runs normally.
    const command = createCommandFixture();
    const ctx = createCommandContext("doctor clean", true);
    const result = await command.handler(ctx);
    const text = (result as { text: string }).text;
    expect(text).not.toMatch(/operator-only/i);
  });

  // ────────────────────────────────────────────────────────────────────
  // Wave-12 meta-test: every `parsed.apply`/`parsed.X` flag inside a
  // case body that mutates state has a senderIsOwner guard.
  //
  // The reviewer's diagnosis: switch cases hide multiple behaviors. The
  // case-name-based invariant above misses sub-flag mutating variants
  // (doctor / doctor_cleaners had `parsed.apply` paths that mutate).
  // This test scans the source for any branch on `parsed.apply` inside
  // an operator-handler case body; for each, asserts there's a
  // `senderIsOwner` check before the apply branch.
  // ────────────────────────────────────────────────────────────────────

  it("INVARIANT: every `parsed.apply` branch inside a handler case has a senderIsOwner gate", () => {
    const source = readFileSync(LCM_COMMAND_PATH, "utf8");
    // Find every `parsed.apply` or similar mutation-flag reference
    // inside what looks like a handler case body (after the parser
    // switch, in the dispatch switch). We bracket the dispatch switch
    // by its enclosing `case` indent (8 spaces) and look for
    // `parsed.apply` references.
    //
    // For each handler case that contains `parsed.apply`, verify the
    // case body also contains `senderIsOwner` AND that they appear
    // before any actual mutation (`buildXxxApplyText`/`runXxx`).
    // Heuristic: the gate appears before the apply-dispatch in the
    // case body.
    const handlerSwitchStart = source.indexOf("// 4. Dispatch");
    // Cases in the handler dispatch start with `        case "X":` (8 spaces).
    const casesWithApply: Array<{ name: string; body: string }> = [];
    const caseRe = /^ {8}case "([a-z_]+)":\s*\{?([\s\S]*?)(?=^ {8}case "|^ {8}default|^ {6}\})/gm;
    let m: RegExpExecArray | null;
    const handlerSection =
      handlerSwitchStart >= 0 ? source.slice(handlerSwitchStart) : source;
    while ((m = caseRe.exec(handlerSection)) !== null) {
      const name = m[1]!;
      const body = m[2]!;
      if (body.includes("parsed.apply") || body.includes("parsed?.apply")) {
        casesWithApply.push({ name, body });
      }
    }
    // Must find at least the doctor / doctor_cleaners cases (sanity).
    expect(casesWithApply.map((c) => c.name).sort()).toEqual(
      expect.arrayContaining(["doctor", "doctor_cleaners"]),
    );
    // For each case with `parsed.apply`, the case body must contain
    // a `senderIsOwner` gate. (We don't enforce ordering — but the
    // gate must exist somewhere in the body.)
    for (const { name, body } of casesWithApply) {
      expect(
        body,
        `case "${name}" has a parsed.apply branch but no senderIsOwner gate`,
      ).toMatch(/senderIsOwner/);
    }
  });
});

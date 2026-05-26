/**
 * Schema / placeholder drift static-analysis test layer (Wave-10 A9).
 *
 * # Why this exists
 *
 * Wave-9 P1.9 was a `{{date_range}}` orphan placeholder: a placeholder
 * declared in a seeded prompt template that NO substitution function ever
 * handled. The TS compiler can't catch this — it's a string-vs-string
 * runtime drift between two unrelated files (seed prompts and dispatch
 * renderers).
 *
 * This file pins three drift classes that audits-but-not-tests caught in
 * Waves 1-9:
 *
 *   1. Placeholder drift  — every `{{x}}` in a seeded template MUST have
 *      a renderer-side substitution. Otherwise the LLM gets the literal
 *      `{{x}}` in its prompt.
 *
 *   2. CHECK constraint drift — every CHECK enum on `tier_label` MUST
 *      accept every TierLabel value the dispatch.ts code produces.
 *      Otherwise dispatch crashes the moment it tries to write a row.
 *      (Final.review.3 Loop 4 Bug 4.4 was exactly this — "year" allowed,
 *      "yearly" not, so yearly synthesis crashed on cache write.)
 *
 *   3. Manifest / registration drift — every tool listed in
 *      `openclaw.plugin.json` `contracts.tools` MUST have a corresponding
 *      `api.registerTool(...)` call in src/plugin/index.ts AND a factory
 *      file in src/tools/. Otherwise the manifest claims the plugin
 *      surfaces a tool that doesn't exist (Wave-9 Slice 1 Loop 7 vapor
 *      tools issue).
 *
 *   4. FK ON DELETE explicitness — every `REFERENCES <t>(<c>)` MUST be
 *      followed by an explicit `ON DELETE <action>`. SQLite's silent
 *      default is NO ACTION (= RESTRICT for inline FKs at constraint-
 *      check time). A refactor that adds an FK without considering
 *      cascade semantics passes silently. We require the author to
 *      pick a clause.
 *
 *   5. Operator command parser/handler symmetry — every `case "X":` in
 *      the parser switch MUST have a matching `case "X":` in the handler
 *      switch (and vice versa). Adding a new command to one switch but
 *      not the other yields a runtime kind/type mismatch.
 *
 * All checks are static analysis on source-file strings. No DB ops, no
 * network. Total run time should be < 2 seconds.
 *
 * # When this test fails
 *
 *   - Test 1 fails → a real placeholder drift bug. Either remove the
 *     unused placeholder from the seed template, or add a substitution
 *     in renderPrompt/renderVerifyPrompt/renderJudgePrompt.
 *   - Test 2 fails → a real CHECK drift. Either widen the CHECK or
 *     constrain the TierLabel union.
 *   - Test 3 fails → manifest claims a tool that doesn't exist or a
 *     factory exists but isn't wired. Either remove from manifest or
 *     wire the registerTool call.
 *   - Test 4 fails → an FK has no explicit ON DELETE clause. Decide
 *     CASCADE / SET NULL / RESTRICT and add it.
 *   - Test 5 fails → parser and handler switches drifted. Add the
 *     missing case to whichever side lacks it.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "..");

function readSrc(relPath: string): string {
  return readFileSync(resolve(REPO_ROOT, relPath), "utf8");
}

// ────────────────────────────────────────────────────────────────────
// Test 1: every {{placeholder}} in seeded prompts has a renderer
// ────────────────────────────────────────────────────────────────────

/**
 * Extract all distinct `{{name}}` placeholders that appear INSIDE a
 * `template:` backtick literal in seed-default-prompts.ts. Docstring
 * mentions like "Wave-9 fix removed `{{date_range}}` ..." are excluded
 * because they appear OUTSIDE template blocks.
 */
function extractSeedTemplatePlaceholders(seedSrc: string): {
  byTemplate: Array<{ memoryType: string; placeholders: Set<string> }>;
  all: Set<string>;
} {
  // Find each entry in DEFAULT_PROMPTS by locating the (memoryType, template)
  // pair within an object literal. We anchor on `memoryType: "..."` then
  // search forward for the next `template: \`...\`` block.
  const byTemplate: Array<{ memoryType: string; placeholders: Set<string> }> = [];
  const all = new Set<string>();
  // Match memoryType + capture the template body. The body may contain
  // escaped backticks (\`) used for inline-code formatting inside the
  // template (e.g. the verify_fidelity prompt at §12 emits `OK: ...`).
  // We match either (a) any non-backslash non-backtick character, or
  // (b) a backslash followed by any character (covering \` escapes
  // and any other escape sequence used inside the literal).
  const pattern = /memoryType:\s*"([^"]+)"[\s\S]*?template:\s*`((?:\\.|[^`\\])*)`/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(seedSrc)) !== null) {
    const memoryType = m[1]!;
    const templateBody = m[2]!;
    const placeholders = new Set<string>();
    // Extract {{name}} (with optional whitespace) — same syntax the
    // renderers use.
    const phPattern = /\{\{\s*([a-z_]+)\s*\}\}/g;
    let p: RegExpExecArray | null;
    while ((p = phPattern.exec(templateBody)) !== null) {
      placeholders.add(p[1]!);
      all.add(p[1]!);
    }
    byTemplate.push({ memoryType, placeholders });
  }
  return { byTemplate, all };
}

/**
 * Extract all placeholder names that ANY renderer in dispatch.ts
 * substitutes. We scan for `.replace(/\{\{\s*NAME\s*\}\}/g, ...)`
 * patterns — the canonical form used by renderPrompt /
 * renderVerifyPrompt / renderJudgePrompt.
 */
function extractRenderedPlaceholders(dispatchSrc: string): Set<string> {
  const rendered = new Set<string>();
  // Match the canonical regex literal used by all three renderers.
  // Slashes escape: literal `\{\{\s*` start, name, `\s*\}\}/g` end.
  const pattern = /\.replace\(\s*\/\\\{\\\{\\s\*([a-z_]+)\\s\*\\\}\\\}\/g/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(dispatchSrc)) !== null) {
    rendered.add(m[1]!);
  }
  return rendered;
}

describe("schema-drift invariant — Test 1: seeded prompt placeholders all have renderers", () => {
  const seedSrc = readSrc("src/synthesis/seed-default-prompts.ts");
  const dispatchSrc = readSrc("src/synthesis/dispatch.ts");
  const { byTemplate, all: seedPlaceholders } = extractSeedTemplatePlaceholders(seedSrc);
  const renderedPlaceholders = extractRenderedPlaceholders(dispatchSrc);

  it("extraction sanity: at least one seeded prompt found", () => {
    expect(byTemplate.length).toBeGreaterThanOrEqual(8);
  });

  it("extraction sanity: at least one renderer substitution found", () => {
    // Wave-9 P1.9 anchors: source_text + tier + memory_type from
    // renderPrompt; source_leaves + draft from renderVerifyPrompt;
    // candidates from renderJudgePrompt. If extraction breaks, this
    // catches it before the real assertion.
    expect(renderedPlaceholders.size).toBeGreaterThanOrEqual(5);
    expect(renderedPlaceholders.has("source_text")).toBe(true);
  });

  it("every {{placeholder}} in a seed template has a corresponding renderer substitution", () => {
    const orphans: string[] = [];
    for (const ph of seedPlaceholders) {
      if (!renderedPlaceholders.has(ph)) {
        // Find which template uses it for a useful failure message.
        const usedBy = byTemplate
          .filter((t) => t.placeholders.has(ph))
          .map((t) => t.memoryType);
        orphans.push(
          `  {{${ph}}} appears in seed prompt(s) [${usedBy.join(", ")}] but no renderer substitutes it`,
        );
      }
    }
    if (orphans.length > 0) {
      throw new Error(
        "Orphan placeholder(s) detected in seeded prompts — these will be sent VERBATIM to the LLM:\n" +
          orphans.join("\n") +
          "\nFix: either remove the placeholder from the seed template, OR add a substitution in renderPrompt/renderVerifyPrompt/renderJudgePrompt in src/synthesis/dispatch.ts.",
      );
    }
    expect(orphans).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────
// Test 2: every tier_label CHECK accepts all TierLabel values
// ────────────────────────────────────────────────────────────────────

/**
 * Extract the TierLabel union members from dispatch.ts. The shape is:
 *   export type TierLabel =
 *     | "daily"
 *     | "weekly"
 *     | ...
 */
function extractTierLabelValues(dispatchSrc: string): Set<string> {
  const m = dispatchSrc.match(/export type TierLabel\s*=([^;]+);/);
  if (!m) {
    throw new Error(
      "[v41-schema-drift] could not locate `export type TierLabel = ...;` in dispatch.ts; the regex needs updating",
    );
  }
  const body = m[1]!;
  const values = new Set<string>();
  const lit = /"([a-z_]+)"/g;
  let q: RegExpExecArray | null;
  while ((q = lit.exec(body)) !== null) values.add(q[1]!);
  return values;
}

/**
 * Find every CHECK constraint of the form `tier_label IN (...)` in
 * migration.ts and return the per-CHECK accepted-values set.
 */
function extractTierLabelChecks(
  migrationSrc: string,
): Array<{ tableHint: string; lineNumber: number; values: Set<string> }> {
  const checks: Array<{ tableHint: string; lineNumber: number; values: Set<string> }> = [];
  // Walk line-by-line so we can report accurate line numbers + capture
  // a hint of which table the CHECK belongs to (the CREATE TABLE name
  // from the most recent CREATE TABLE seen above this CHECK).
  const lines = migrationSrc.split("\n");
  let lastCreateTable = "<unknown>";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const ctMatch = line.match(/CREATE TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)/i);
    if (ctMatch) lastCreateTable = ctMatch[1]!;
    const checkMatch = line.match(/tier_label[^()]*?IN\s*\(([^)]+)\)/i);
    if (checkMatch) {
      const values = new Set<string>();
      const lit = /'([a-z_]+)'/g;
      let q: RegExpExecArray | null;
      while ((q = lit.exec(checkMatch[1]!)) !== null) values.add(q[1]!);
      checks.push({ tableHint: lastCreateTable, lineNumber: i + 1, values });
    }
  }
  return checks;
}

describe("schema-drift invariant — Test 2: tier_label CHECK accepts every TierLabel value", () => {
  const dispatchSrc = readSrc("src/synthesis/dispatch.ts");
  const migrationSrc = readSrc("src/db/migration.ts");
  const tierLabels = extractTierLabelValues(dispatchSrc);
  const checks = extractTierLabelChecks(migrationSrc);

  it("extraction sanity: TierLabel union is non-empty", () => {
    // The union is daily/weekly/monthly/yearly/custom/filtered = 6 values.
    expect(tierLabels.size).toBeGreaterThanOrEqual(6);
    expect(tierLabels.has("daily")).toBe(true);
    expect(tierLabels.has("yearly")).toBe(true);
  });

  it("extraction sanity: at least one tier_label CHECK was found", () => {
    expect(checks.length).toBeGreaterThanOrEqual(1);
  });

  it("every tier_label CHECK accepts every TierLabel value", () => {
    const failures: string[] = [];
    for (const check of checks) {
      const missing: string[] = [];
      for (const tl of tierLabels) {
        if (!check.values.has(tl)) missing.push(tl);
      }
      if (missing.length > 0) {
        failures.push(
          `  Table ${check.tableHint} (migration.ts:${check.lineNumber}) tier_label CHECK does not accept: [${missing.join(", ")}] (CHECK accepts: [${[...check.values].join(", ")}])`,
        );
      }
    }
    if (failures.length > 0) {
      throw new Error(
        "tier_label CHECK constraint drift — synthesis will crash when dispatch tries to write a tier_label that the CHECK rejects:\n" +
          failures.join("\n") +
          "\nFix: either widen the CHECK in migration.ts (and add a migration step to ALTER existing DBs), OR narrow the TierLabel union in dispatch.ts.",
      );
    }
    expect(failures).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────
// Test 3: manifest tools match registered tools and factory files
// ────────────────────────────────────────────────────────────────────

interface ManifestShape {
  contracts?: { tools?: string[] };
}

/**
 * Extract tool names from registerTool factory call sites in
 * src/plugin/index.ts. We can't easily evaluate JS — instead we look
 * at the imported `createLcm*Tool` factory names and walk to the
 * declared `name: "..."` field within the corresponding tool source
 * file.
 */
function extractRegisteredToolFactories(pluginIndexSrc: string): string[] {
  const factories: string[] = [];
  const pattern = /(createLcm[A-Z][a-zA-Z]*Tool)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(pluginIndexSrc)) !== null) {
    if (!factories.includes(m[1]!)) factories.push(m[1]!);
  }
  return factories;
}

/**
 * Convert a factory name (createLcmGrepTool) into the expected
 * filename (lcm-grep-tool.ts) and read the `name: "..."` field
 * from inside it.
 */
function resolveFactoryToToolName(factoryName: string): { fileName: string; toolName: string | null } {
  // createLcmFooBarTool → lcm-foo-bar-tool.ts
  const stripped = factoryName.replace(/^create/, "").replace(/Tool$/, "");
  // LcmFooBar → lcm-foo-bar
  const kebab =
    "lcm-" +
    stripped
      .replace(/^Lcm/, "")
      .replace(/([A-Z])/g, (_, c) => "-" + c.toLowerCase())
      .replace(/^-+/, "") +
    "-tool.ts";
  const path = `src/tools/${kebab}`;
  let toolName: string | null = null;
  try {
    const src = readSrc(path);
    const m = src.match(/name:\s*"(lcm_[a-z_]+)"/);
    if (m) toolName = m[1]!;
  } catch {
    // File missing — handled by caller.
  }
  return { fileName: kebab, toolName };
}

describe("schema-drift invariant — Test 3: manifest tools match registered tools and factories", () => {
  const manifestRaw = readSrc("openclaw.plugin.json");
  const pluginIndexSrc = readSrc("src/plugin/index.ts");
  const manifest = JSON.parse(manifestRaw) as ManifestShape;
  const manifestTools = manifest.contracts?.tools ?? [];
  const factories = extractRegisteredToolFactories(pluginIndexSrc);

  it("extraction sanity: manifest declares at least 1 tool", () => {
    expect(manifestTools.length).toBeGreaterThanOrEqual(1);
  });

  it("extraction sanity: plugin/index.ts has at least 1 registerTool factory call", () => {
    expect(factories.length).toBeGreaterThanOrEqual(1);
  });

  it("count of manifest tools equals count of distinct factory invocations", () => {
    if (manifestTools.length !== factories.length) {
      throw new Error(
        `Tool count mismatch: manifest declares ${manifestTools.length} tools (${manifestTools.join(", ")}) but src/plugin/index.ts has ${factories.length} distinct registerTool factory calls (${factories.join(", ")}). Each manifest entry must correspond to exactly one registerTool call.`,
      );
    }
    expect(factories.length).toBe(manifestTools.length);
  });

  it("every manifest-declared tool has a matching factory + factory file + name field", () => {
    const failures: string[] = [];
    const factoryToolNames = new Set<string>();
    for (const f of factories) {
      const { fileName, toolName } = resolveFactoryToToolName(f);
      if (!toolName) {
        failures.push(
          `  Factory ${f}() referenced from src/plugin/index.ts but src/tools/${fileName} either does not exist or has no \`name: "lcm_..."\` field`,
        );
        continue;
      }
      factoryToolNames.add(toolName);
    }
    for (const declared of manifestTools) {
      if (!factoryToolNames.has(declared)) {
        failures.push(
          `  Manifest declares "${declared}" in contracts.tools but no factory in src/plugin/index.ts produces a tool with name="${declared}"`,
        );
      }
    }
    for (const registered of factoryToolNames) {
      if (!manifestTools.includes(registered)) {
        failures.push(
          `  Tool "${registered}" is registered via api.registerTool but not declared in openclaw.plugin.json contracts.tools`,
        );
      }
    }
    if (failures.length > 0) {
      throw new Error(
        "Manifest <-> registration drift detected:\n" +
          failures.join("\n") +
          "\nFix: align openclaw.plugin.json contracts.tools with the registerTool calls in src/plugin/index.ts.",
      );
    }
    expect(failures).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────
// Test 4: every FK declares an explicit ON DELETE clause
// ────────────────────────────────────────────────────────────────────

/**
 * Find every `REFERENCES <table>(<col>)` token in migration.ts that
 * is NOT followed by `ON DELETE`. We tolerate whitespace + an
 * optional ON UPDATE clause between the REFERENCES and ON DELETE,
 * but the ON DELETE itself must be explicit.
 *
 * False positives: docstring lines that describe REFERENCES
 * conceptually (no actual FK syntax). We filter those by requiring
 * the line NOT to start with `*` or `//` (comment markers).
 */
function findFKsWithoutExplicitOnDelete(
  migrationSrc: string,
): Array<{ lineNumber: number; line: string }> {
  const offenders: Array<{ lineNumber: number; line: string }> = [];
  const lines = migrationSrc.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Skip lines that are clearly comments (line-comment or jsdoc body).
    const trimmed = line.trimStart();
    if (trimmed.startsWith("*") || trimmed.startsWith("//")) continue;
    // Look for REFERENCES <id>(<id>) that is not followed by ON DELETE
    // anywhere on the same line. (All FK declarations in this codebase
    // fit on one line; if a multi-line FK ever appears, this regex
    // will need to be widened to a multi-line scan.)
    const refMatch = line.match(/REFERENCES\s+\w+\s*\(\s*\w+\s*\)/);
    if (!refMatch) continue;
    if (/ON\s+DELETE/i.test(line)) continue;
    offenders.push({ lineNumber: i + 1, line: trimmed });
  }
  return offenders;
}

describe("schema-drift invariant — Test 4: every FK declares an explicit ON DELETE clause", () => {
  const migrationSrc = readSrc("src/db/migration.ts");
  const offenders = findFKsWithoutExplicitOnDelete(migrationSrc);

  it("every FK in migration.ts has an explicit ON DELETE clause", () => {
    if (offenders.length > 0) {
      const lines = offenders
        .map(
          (o) =>
            `  migration.ts:${o.lineNumber}  ${o.line.slice(0, 120)}${o.line.length > 120 ? "..." : ""}`,
        )
        .join("\n");
      throw new Error(
        `FK declaration(s) without explicit ON DELETE clause:\n${lines}\nSQLite's silent default is NO ACTION (= RESTRICT for inline FKs). Pick CASCADE / SET NULL / RESTRICT / SET DEFAULT / NO ACTION explicitly so refactors can't drift cascade semantics.`,
      );
    }
    expect(offenders).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────
// Test 5: parser and handler switches in lcm-command.ts are symmetric
// ────────────────────────────────────────────────────────────────────

/**
 * Extract case names from a switch block. Returns the kinds the parser
 * outputs (the `kind: "X"` values returned from parseLcmCommand) and
 * the kinds the handler dispatches on (the `case "X":` values inside
 * the handler's switch).
 *
 * Implementation: walk the file collecting "kind: \"X\"" string
 * literals from the parser-side, then walk the handler's switch
 * collecting "case \"X\":" labels. We bound by line ranges so
 * unrelated string literals inside other source code don't pollute
 * the result.
 */
function extractParserHandlerKinds(commandSrc: string): {
  parserKinds: Set<string>;
  handlerKinds: Set<string>;
} {
  const parserKinds = new Set<string>();
  const handlerKinds = new Set<string>();

  // The parser is `function parseLcmCommand(...)` — its returned shape
  // sets `kind: "X"`. Find that function's body bounds, then scan
  // for `kind: "..."` literals.
  const parserStart = commandSrc.indexOf("function parseLcmCommand(");
  if (parserStart < 0) {
    throw new Error("[v41-schema-drift] could not locate parseLcmCommand in lcm-command.ts");
  }
  // The parser ends at the next top-level `}\n\n` followed by
  // `function ` or `export `. The simplest robust bound: look for
  // the next `^function ` or `^export ` after parserStart.
  const parserBody = commandSrc.slice(parserStart);
  const parserEndMatch = parserBody.search(/\n(?:export\s+)?function\s+\w+/);
  // parserEndMatch is relative to parserBody; ensure we don't pick the
  // very first line (parseLcmCommand itself). Skip past line 0.
  const afterFirst = parserBody.slice(1).search(/\n(?:export\s+)?function\s+\w+/);
  const parserBodySection = afterFirst > 0
    ? parserBody.slice(0, afterFirst + 1)
    : parserEndMatch > 0
      ? parserBody.slice(0, parserEndMatch)
      : parserBody;
  const kindLit = /kind:\s*"([a-z_]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = kindLit.exec(parserBodySection)) !== null) {
    if (m[1] !== "help") parserKinds.add(m[1]!); // help is the catch-all error path
  }

  // The handler switch lives inside the `handler: async (ctx) => {` block.
  // Bound: from `handler: async` to the matching `},`.
  const handlerStart = commandSrc.indexOf("handler: async");
  if (handlerStart < 0) {
    throw new Error("[v41-schema-drift] could not locate `handler: async` in lcm-command.ts");
  }
  const handlerBody = commandSrc.slice(handlerStart);
  const handlerEnd = handlerBody.search(/\n  \},\n\s*\};/);
  const handlerSection = handlerEnd > 0 ? handlerBody.slice(0, handlerEnd) : handlerBody;
  // Restrict the case-extraction to the immediate switch body — only
  // consider `case "X":` labels (skip `case "--flag":` parser-side
  // flag tokens, which the parser-internal switch uses).
  const caseLit = /case\s+"([a-z_]+)"\s*:/g;
  let c: RegExpExecArray | null;
  while ((c = caseLit.exec(handlerSection)) !== null) {
    if (c[1] !== "help") handlerKinds.add(c[1]!);
  }

  return { parserKinds, handlerKinds };
}

describe("schema-drift invariant — Test 5: parser and handler switches symmetric", () => {
  const commandSrc = readSrc("src/plugin/lcm-command.ts");
  const { parserKinds, handlerKinds } = extractParserHandlerKinds(commandSrc);

  it("extraction sanity: parser and handler each have at least 5 cases", () => {
    expect(parserKinds.size).toBeGreaterThanOrEqual(5);
    expect(handlerKinds.size).toBeGreaterThanOrEqual(5);
  });

  it("every parser-emitted kind has a matching handler case", () => {
    const orphans: string[] = [];
    for (const k of parserKinds) {
      if (!handlerKinds.has(k)) orphans.push(k);
    }
    if (orphans.length > 0) {
      throw new Error(
        `Parser emits kind(s) the handler does not dispatch: [${orphans.join(", ")}]. The handler switch in lcm-command.ts must add a \`case "X":\` for each.`,
      );
    }
    expect(orphans).toEqual([]);
  });

  it("every handler case is reachable from a parser-emitted kind", () => {
    const orphans: string[] = [];
    for (const k of handlerKinds) {
      if (!parserKinds.has(k)) orphans.push(k);
    }
    if (orphans.length > 0) {
      throw new Error(
        `Handler dispatches kind(s) the parser never emits: [${orphans.join(", ")}]. Either remove the dead handler case OR add a parser path that emits the kind.`,
      );
    }
    expect(orphans).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────
// Test 6 (bonus): memory_type + pass_kind CHECK constraints align with
// the TypeScript union literals in src/synthesis/prompt-registry.ts
// ────────────────────────────────────────────────────────────────────

/**
 * Extract the union literals for `MemoryType` and `PassKind` from
 * src/synthesis/prompt-registry.ts. Both are simple string-literal
 * unions: `export type X = "a" | "b" | ...;`.
 */
function extractUnion(src: string, typeName: string): Set<string> {
  // Anchored on `export type X =` and bounded by the first semicolon.
  const re = new RegExp(`export type ${typeName}\\s*=([^;]+);`);
  const m = src.match(re);
  if (!m) {
    throw new Error(`[v41-schema-drift] could not locate \`export type ${typeName}\` in prompt-registry.ts`);
  }
  const values = new Set<string>();
  const lit = /"([a-z_-]+)"/g;
  let q: RegExpExecArray | null;
  while ((q = lit.exec(m[1]!)) !== null) values.add(q[1]!);
  return values;
}

/**
 * Find the lcm_prompt_registry CHECK constraints. Returns the values
 * accepted by the memory_type and pass_kind CHECKs.
 */
function extractPromptRegistryChecks(migrationSrc: string): {
  memoryTypeValues: Set<string>;
  passKindValues: Set<string>;
} {
  const memoryTypeValues = new Set<string>();
  const passKindValues = new Set<string>();

  // memory_type CHECK is multi-line; capture from `memory_type` to the
  // closing `))`.
  const mtMatch = migrationSrc.match(
    /memory_type\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*memory_type\s+IN\s*\(([^)]+)\)\s*\)/i,
  );
  if (mtMatch) {
    const lit = /'([a-z_-]+)'/g;
    let q: RegExpExecArray | null;
    while ((q = lit.exec(mtMatch[1]!)) !== null) memoryTypeValues.add(q[1]!);
  }

  const pkMatch = migrationSrc.match(
    /pass_kind\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*pass_kind\s+IN\s*\(([^)]+)\)\s*\)/i,
  );
  if (pkMatch) {
    const lit = /'([a-z_-]+)'/g;
    let q: RegExpExecArray | null;
    while ((q = lit.exec(pkMatch[1]!)) !== null) passKindValues.add(q[1]!);
  }

  return { memoryTypeValues, passKindValues };
}

describe("schema-drift invariant — Test 6 (bonus): memory_type + pass_kind CHECKs match TS unions", () => {
  const migrationSrc = readSrc("src/db/migration.ts");
  const promptRegistrySrc = readSrc("src/synthesis/prompt-registry.ts");
  const memoryTypeUnion = extractUnion(promptRegistrySrc, "MemoryType");
  const passKindUnion = extractUnion(promptRegistrySrc, "PassKind");
  const { memoryTypeValues, passKindValues } = extractPromptRegistryChecks(migrationSrc);

  it("extraction sanity: MemoryType union has at least 5 members", () => {
    expect(memoryTypeUnion.size).toBeGreaterThanOrEqual(5);
  });

  it("extraction sanity: PassKind union has at least 3 members", () => {
    expect(passKindUnion.size).toBeGreaterThanOrEqual(3);
  });

  it("extraction sanity: lcm_prompt_registry CHECK constraints found", () => {
    expect(memoryTypeValues.size).toBeGreaterThanOrEqual(1);
    expect(passKindValues.size).toBeGreaterThanOrEqual(1);
  });

  it("memory_type CHECK accepts every MemoryType union value", () => {
    const missing: string[] = [];
    for (const v of memoryTypeUnion) {
      if (!memoryTypeValues.has(v)) missing.push(v);
    }
    if (missing.length > 0) {
      throw new Error(
        `lcm_prompt_registry.memory_type CHECK does not accept TS MemoryType value(s): [${missing.join(", ")}]. Either widen the CHECK or narrow the union.`,
      );
    }
    expect(missing).toEqual([]);
  });

  it("pass_kind CHECK accepts every PassKind union value", () => {
    const missing: string[] = [];
    for (const v of passKindUnion) {
      if (!passKindValues.has(v)) missing.push(v);
    }
    if (missing.length > 0) {
      throw new Error(
        `lcm_prompt_registry.pass_kind CHECK does not accept TS PassKind value(s): [${missing.join(", ")}]. Either widen the CHECK or narrow the union.`,
      );
    }
    expect(missing).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import manifest from "../openclaw.plugin.json" with { type: "json" };

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_INDEX = resolve(HERE, "..", "src", "plugin", "index.ts");

/**
 * These tests guard against drift between the names registered at runtime via
 * `api.registerTool(...)` and the names declared in `openclaw.plugin.json`'s
 * `contracts.tools` array.
 *
 * Background: PR #555 added `contracts.tools` because OpenClaw 2026.5.2+ rejects
 * plugin tool registrations that aren't pre-declared in the manifest. The
 * failure mode is silent — engine logs "Engine initialized" but compaction is
 * a no-op. If a 5th tool is added/renamed without updating the manifest, this
 * test catches it before users do.
 *
 * The drift surface:
 *   - `src/plugin/index.ts` calls `api.registerTool` with factories like
 *     `createLcmGrepTool`, which wrap a tool object whose `name:` field is the
 *     canonical id (e.g. "lcm_grep").
 *   - `openclaw.plugin.json#contracts.tools` is the static declaration.
 *
 * To keep the test robust to refactors, we walk the registerTool factories
 * forward to the source files that define each tool's `name:` and grep those
 * for the canonical strings. This catches both manifest-side drift (forgot to
 * add a name) and source-side drift (renamed a tool).
 */

const TOOL_FACTORY_FILES = [
  "src/tools/lcm-grep-tool.ts",
  "src/tools/lcm-describe-tool.ts",
  "src/tools/lcm-expand-tool.ts",
  "src/tools/lcm-expand-query-tool.ts",
] as const;

function extractToolNames(): string[] {
  const names = new Set<string>();
  for (const rel of TOOL_FACTORY_FILES) {
    const abs = resolve(HERE, "..", rel);
    const src = readFileSync(abs, "utf8");
    // Match e.g. `name: "lcm_grep",` or `name: 'lcm_grep'`. The tool name is
    // a tightly-constrained identifier (lcm_<word>), so the regex is narrow on
    // purpose to avoid matching unrelated `name:` fields like JSON-schema
    // property names.
    const matches = src.matchAll(/\bname\s*:\s*["'](lcm_[a-z_]+)["']/g);
    for (const m of matches) names.add(m[1]);
  }
  return [...names].sort();
}

function extractRegisterToolFactoryCallSites(): string[] {
  const src = readFileSync(PLUGIN_INDEX, "utf8");
  // Find each `api.registerTool(...)` call and capture the inner factory
  // identifier (e.g. createLcmGrepTool). This catches the case where a new
  // registerTool call is added but the contracts.tools array isn't updated.
  const matches = src.matchAll(/api\.registerTool\s*\(\s*\([^)]*\)\s*=>\s*\n?\s*(create[A-Za-z]+Tool)\b/g);
  return [...matches].map((m) => m[1]).sort();
}

describe("openclaw.plugin.json manifest drift guard (#570)", () => {
  it("contracts.tools matches the canonical name fields in src/tools/*", () => {
    const declared = [...manifest.contracts.tools].sort();
    const fromSource = extractToolNames();
    expect(declared).toEqual(fromSource);
  });

  it("contracts.tools enumerates one entry per registerTool call site", () => {
    const factories = extractRegisterToolFactoryCallSites();
    // Each createLcm*Tool factory must correspond to exactly one declared
    // contract. If a registerTool call is added without a manifest update,
    // factories.length grows and this assertion fails.
    expect(factories.length).toBe(manifest.contracts.tools.length);
    // Each factory name should map 1:1 to a declared tool (createLcmGrepTool
    // -> lcm_grep, createLcmExpandQueryTool -> lcm_expand_query, etc.).
    const factoryToName = (s: string): string =>
      s
        .replace(/^create/, "")
        .replace(/Tool$/, "")
        .replace(/([a-z])([A-Z])/g, "$1_$2")
        .toLowerCase();
    const expected = factories.map(factoryToName).sort();
    const declared = [...manifest.contracts.tools].sort();
    expect(declared).toEqual(expected);
  });

  it("declares context-engine kind so the Windows installer's hook-pack detector sees a kind discriminator (#451)", () => {
    expect(manifest.kind).toBe("context-engine");
  });
});

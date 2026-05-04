import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import manifest from "../openclaw.plugin.json" with { type: "json" };

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_TOOLS_DIR = resolve(HERE, "..", "src", "tools");
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
 * To keep the test robust to refactors:
 *   - Tool source files are discovered by scanning `src/tools/lcm-*-tool.ts`,
 *     so adding a new tool file doesn't require editing this test.
 *   - The `registerTool` matcher accepts both arrow-expression bodies (`(ctx)
 *     => createXTool(...)`) and arrow-block bodies (`(ctx) => { return
 *     createXTool(...) }`), so a refactor to a block body doesn't fail
 *     spuriously.
 */

function discoverToolFactoryFiles(): string[] {
  return readdirSync(SRC_TOOLS_DIR)
    .filter((name) => /^lcm-[a-z0-9-]+-tool\.ts$/.test(name))
    .map((name) => resolve(SRC_TOOLS_DIR, name));
}

function extractToolNames(): string[] {
  const names = new Set<string>();
  for (const abs of discoverToolFactoryFiles()) {
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
  // identifier (e.g. createLcmGrepTool). Tolerates both expression-body and
  // block-body arrow forms, optional async, and any whitespace/newlines:
  //
  //   api.registerTool((ctx) => createLcmGrepTool(...))
  //   api.registerTool((ctx) => { return createLcmGrepTool(...) })
  //   api.registerTool(async (ctx) => createLcmGrepTool(...))
  const pattern =
    /api\.registerTool\s*\(\s*(?:async\s+)?\([^)]*\)\s*=>\s*\{?\s*(?:return\s+)?(create[A-Za-z]+Tool)\b/g;
  const matches = src.matchAll(pattern);
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

  it("declares startup activation until OpenClaw always loads selected context-engine plugins", () => {
    expect(manifest.kind).toBe("context-engine");
    expect(manifest.activation?.onStartup).toBe(true);
  });
});

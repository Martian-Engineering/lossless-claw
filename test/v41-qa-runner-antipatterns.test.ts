/**
 * QA-runner antipattern static-scan.
 *
 * # Why this exists
 *
 * Wave-12 audit Wave-1 found that QA-runner case F5 had its
 * graceful-degradation regex check AFTER a bare `if (r.error) return
 * "errored:..."`. The bare-error short-circuit fired first, making the
 * graceful-degradation allowance dead code. F5 marked Voyage rate-limit
 * results as failures even though the case explicitly intended to allow
 * Voyage-unavailable as graceful.
 *
 * The runner has 30+ test-case closures. Each can independently re-
 * introduce the antipattern. Static scanning is the cheapest reliable
 * defense: parse the case bodies, detect "bare error before graceful
 * check," fail the test.
 *
 * # When this test fails
 *
 *   - A closure has `if (r.error) return` BEFORE a graceful regex
 *     check (Voyage / vec0 / LLM / summarization model) → reorder so
 *     graceful comes first.
 *   - A new external-dep tool case was added without a graceful path
 *     → add the graceful regex check at the top of the closure.
 *
 * # Why static, not behavioral
 *
 * The runner imports a live DB + tool factories at module load + has
 * no test-mode export. Refactoring it into a testable module is a
 * separate work item. Static scan covers the specific antipattern
 * class without that refactor.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(__dirname, "..");
const RUNNER_PATH = join(REPO_ROOT, "scripts/v41-qa-runner.mjs");

/**
 * Extract each `expect: (r) => { ... }` closure body from the runner
 * source. Returns an array of {caseId, body} objects.
 */
function extractExpectClosures(): Array<{ caseId: string; body: string }> {
  const src = readFileSync(RUNNER_PATH, "utf8");
  const closures: Array<{ caseId: string; body: string }> = [];

  // Match each test-case object: id: "...", ... expect: (r) => { ... }
  // Use a simple line-by-line state machine: when we see `id: "x"`,
  // record the id; when we see `expect: (r) => {`, capture lines until
  // the matching closing brace at the same indentation level.
  const lines = src.split("\n");
  let currentId: string | undefined;
  let inExpectBody = false;
  let braceDepth = 0;
  let bodyLines: string[] = [];

  for (const line of lines) {
    const idMatch = line.match(/^\s*id:\s*"([^"]+)"/);
    if (idMatch) {
      currentId = idMatch[1];
      continue;
    }
    if (!inExpectBody && /^\s*expect:\s*\(r\)\s*=>\s*\{/.test(line)) {
      inExpectBody = true;
      braceDepth = 1;
      bodyLines = [];
      continue;
    }
    if (inExpectBody) {
      // Track braces to find the closing one. Simplified — won't
      // handle braces inside string literals or regex, but the
      // runner's predicates avoid those.
      for (const ch of line) {
        if (ch === "{") braceDepth++;
        else if (ch === "}") braceDepth--;
      }
      bodyLines.push(line);
      if (braceDepth === 0) {
        inExpectBody = false;
        if (currentId) {
          closures.push({ caseId: currentId, body: bodyLines.join("\n") });
        }
      }
    }
  }
  return closures;
}

/**
 * Tools whose closures should accept graceful Voyage/LLM/embedding
 * unavailability without classifying it as a hard failure. Pulled from
 * each tool's external-dependency surface.
 */
const TOOLS_WITH_GRACEFUL_DEPS = new Set([
  "lcm_grep", // Voyage when mode=hybrid/semantic
  "lcm_synthesize_around", // Voyage (semantic window) + LLM (synthesis)
  "lcm_expand_query", // LLM (sub-agent dispatch)
]);

function caseUsesGracefulTool(body: string, caseId: string): boolean {
  // Heuristic: the case's outer record declares `tool: "lcm_xxx"`.
  // Since we only captured the expect closure, search the surrounding
  // case object — easier to just check caseId hints.
  // Cases for graceful-dep tools all start with full-A* / full-B* /
  // smoke-A / smoke-B / full-F3 / full-F5 etc. Read from the runner
  // source directly to find the case's `tool` declaration.
  const src = readFileSync(RUNNER_PATH, "utf8");
  // Find the case block by id and extract its tool field.
  const caseBlockMatch = src.match(
    new RegExp(
      `id:\\s*"${caseId.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}"[\\s\\S]*?tool:\\s*"(lcm_[a-z_]+)"`,
    ),
  );
  if (!caseBlockMatch) return false;
  return TOOLS_WITH_GRACEFUL_DEPS.has(caseBlockMatch[1]!);
}

const GRACEFUL_KEYWORDS = /voyage|vec0|embedding|VOYAGE_API|summariz|summary[Mm]odel|summary[Pp]rovider|LCM_SUMMARY_MODEL|LLM/;

function findFirstLineIndex(body: string, pattern: RegExp): number {
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i]!)) return i;
  }
  return -1;
}

describe("QA-runner antipattern scan — graceful-check ordering (W1 F5 regression)", () => {
  const closures = extractExpectClosures();

  it("found at least 25 expect closures (sanity — runner is large)", () => {
    expect(closures.length).toBeGreaterThanOrEqual(25);
  });

  for (const { caseId, body } of closures) {
    if (!caseUsesGracefulTool(body, caseId)) continue;
    it(`${caseId} — graceful-degradation regex check appears BEFORE bare \`if (r.error) return\``, () => {
      const bareErrorIdx = findFirstLineIndex(body, /if\s*\(\s*r\.error\s*\)\s*return/);
      const gracefulIdx = findFirstLineIndex(
        body,
        new RegExp(
          `if\\s*\\(.*r\\.error.*\\)\\s*\\{?[\\s\\S]*?(${GRACEFUL_KEYWORDS.source})`,
        ),
      );
      // If neither appears, the case doesn't deal with errors at all.
      // If only bare-error appears, the case might be intentional (no
      // graceful path expected). We only flag the explicit antipattern:
      // both exist AND bare-error comes first.
      if (bareErrorIdx === -1 || gracefulIdx === -1) return;
      expect(
        gracefulIdx,
        `Case "${caseId}" has bare \`if (r.error) return\` at line ${bareErrorIdx} ` +
          `BEFORE the graceful-degradation regex check at line ${gracefulIdx}. ` +
          `The bare-error short-circuits before the graceful check can fire — ` +
          `move the graceful check above the bare-error line.`,
      ).toBeLessThan(bareErrorIdx);
    });
  }
});

describe("QA-runner antipattern scan — F1/F4 args alignment (W1 fix regression)", () => {
  const src = readFileSync(RUNNER_PATH, "utf8");

  it("F1 (catalog browse) does NOT use entityType filter", () => {
    const f1Match = src.match(
      /id:\s*"full-F1-browse-by-type"[\s\S]*?args:\s*(\{[^}]+\})/,
    );
    expect(f1Match, "Couldn't locate full-F1-browse-by-type args").toBeTruthy();
    if (f1Match) {
      const args = f1Match[1]!;
      // F1 is "browse what kinds of entities exist" — should NOT filter
      // by a specific entityType. Wave-1 fix swapped F1 and F4 args.
      expect(args).not.toMatch(/entityType:\s*"pr_number"/);
      expect(args).not.toMatch(/entityType:\s*"person_name"/);
    }
  });

  it("F4 (PRs filter) DOES use entityType: pr_number", () => {
    const f4Match = src.match(
      /id:\s*"full-F4-type-filter"[\s\S]*?args:\s*(\{[^}]+\})/,
    );
    expect(f4Match, "Couldn't locate full-F4-type-filter args").toBeTruthy();
    if (f4Match) {
      expect(f4Match[1]!).toMatch(/entityType:\s*"pr_number"/);
    }
  });
});

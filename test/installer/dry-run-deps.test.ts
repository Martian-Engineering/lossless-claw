import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DryRunServiceDeps } from "../../installer/dry-run-deps.js";

describe("DryRunServiceDeps", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  // ── writeFileSync ──────────────────────────────────────────────────────────

  it("writeFileSync prints [dry-run] would write and does not write", () => {
    const path = join(tmpdir(), `lc-dry-run-test-${Date.now()}.json`);
    const deps = new DryRunServiceDeps();
    deps.writeFileSync(path, '{"test":true}');
    expect(existsSync(path)).toBe(false);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(`[dry-run] would write: ${path}`));
  });

  // ── mkdirSync ─────────────────────────────────────────────────────────────

  it("mkdirSync prints [dry-run] would create when dir does not exist", () => {
    const path = join(tmpdir(), `lc-dry-run-dir-${Date.now()}`);
    const deps = new DryRunServiceDeps();
    deps.mkdirSync(path, { recursive: true });
    expect(existsSync(path)).toBe(false);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(`[dry-run] would create: ${path}`));
  });

  it("mkdirSync does NOT print when dir already exists", () => {
    const deps = new DryRunServiceDeps();
    deps.mkdirSync(tmpdir()); // tmpdir always exists
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("[dry-run] would create"));
  });

  // ── rmSync ────────────────────────────────────────────────────────────────

  it("rmSync prints [dry-run] would remove and does not delete", () => {
    // Create a real temp file to confirm it's not deleted
    const path = join(tmpdir(), `lc-dry-run-rm-${Date.now()}.txt`);
    writeFileSync(path, "keep me");
    const deps = new DryRunServiceDeps();
    deps.rmSync(path);
    expect(existsSync(path)).toBe(true); // not deleted
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(`[dry-run] would remove: ${path}`));
    rmSync(path); // cleanup
  });

  // ── spawnSync — normal commands ───────────────────────────────────────────

  it("spawnSync prints [dry-run] would run and returns fake zero-exit", () => {
    const deps = new DryRunServiceDeps();
    const result = deps.spawnSync("launchctl", ["load", "/some/path.plist"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("[dry-run] would run: launchctl load /some/path.plist")
    );
  });

  // ── spawnSync — command -v special case ───────────────────────────────────

  it("spawnSync for 'command -v lossless-claude' returns bare binary name without printing", () => {
    const deps = new DryRunServiceDeps();
    const result = deps.spawnSync("sh", ["-c", "command -v lossless-claude"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("lossless-claude");
    // Should NOT print a [dry-run] line — it's a read-like operation
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("[dry-run] would run: sh"));
  });

  // ── spawnSync — setup.sh special case ────────────────────────────────────

  it("spawnSync for 'bash setup.sh' actually runs setup.sh with XGH_DRY_RUN=1", () => {
    // Script must end in "setup.sh" to trigger the special case
    const scriptPath = join(tmpdir(), `lc-test-setup.sh`);
    writeFileSync(scriptPath, `#!/bin/bash\necho "[dry-run] backend: ollama (test)"`);
    const deps = new DryRunServiceDeps();
    const result = deps.spawnSync("bash", [scriptPath], { env: { ...process.env, XGH_DRY_RUN: "1" } });
    expect(result.status).toBe(0);
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("[dry-run] would run: bash"));
    rmSync(scriptPath);
  });

  // ── promptUser ───────────────────────────────────────────────────────────

  it("promptUser logs [dry-run] would prompt and returns empty string", async () => {
    const deps = new DryRunServiceDeps();
    const result = await deps.promptUser("Pick [1]: ");
    expect(result).toBe("");
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("[dry-run] would prompt: Pick [1]: ")
    );
  });

  // ── readFileSync / existsSync — pass-through ─────────────────────────────

  it("readFileSync delegates to real fs", () => {
    const path = join(tmpdir(), `lc-dry-run-read-${Date.now()}.txt`);
    writeFileSync(path, "hello");
    const deps = new DryRunServiceDeps();
    expect(deps.readFileSync(path, "utf-8")).toBe("hello");
    rmSync(path);
  });

  it("existsSync delegates to real fs", () => {
    const deps = new DryRunServiceDeps();
    expect(deps.existsSync(tmpdir())).toBe(true);
    expect(deps.existsSync("/definitely/does/not/exist/12345")).toBe(false);
  });
});

import {
  existsSync as realExistsSync,
  readFileSync as realReadFileSync,
} from "node:fs";
import { spawnSync as realSpawnSync, type SpawnSyncReturns } from "node:child_process";
import type { ServiceDeps } from "./install.js";
import type { TeardownDeps } from "./uninstall.js";

const fakeZeroExit = (): SpawnSyncReturns<string> => ({
  status: 0,
  stdout: "",
  stderr: "",
  pid: 0,
  output: [],
  signal: null,
  error: undefined,
});

export class DryRunServiceDeps implements ServiceDeps, TeardownDeps {
  // ── intercepted ───────────────────────────────────────────────────────────

  writeFileSync(path: string, _data: string): void {
    console.log(`[dry-run] would write: ${path}`);
  }

  mkdirSync(path: string, _opts?: any): void {
    if (!realExistsSync(path)) {
      console.log(`[dry-run] would create: ${path}`);
    }
  }

  rmSync(path: string): void {
    console.log(`[dry-run] would remove: ${path}`);
  }

  spawnSync(cmd: string, args: string[], opts?: any): SpawnSyncReturns<string> {
    // Special case 1: setup.sh — actually run it with XGH_DRY_RUN=1 so it prints its own preview.
    // Use stdio:"pipe" (not inherited) so we can capture stdout and forward it ourselves,
    // enabling both user-visible output and testable result.stdout.
    if (cmd === "bash" && typeof args[0] === "string" && args[0].endsWith("setup.sh")) {
      const env = { ...(opts?.env ?? process.env), XGH_DRY_RUN: "1" };
      const result = realSpawnSync(cmd, args, { encoding: "utf-8", env, stdio: "pipe" }) as SpawnSyncReturns<string>;
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      return result;
    }

    // Special case 2: binary resolution — return canned result, no output printed
    if (cmd === "sh" && args[0] === "-c" && typeof args[1] === "string" && args[1].startsWith("command -v")) {
      return { ...fakeZeroExit(), stdout: "lossless-claude" };
    }

    // All other commands: print and fake
    console.log(`[dry-run] would run: ${cmd} ${args.join(" ")}`);
    return fakeZeroExit();
  }

  async promptUser(question: string): Promise<string> {
    console.log(`[dry-run] would prompt: ${question}`);
    return "";
  }

  // ── pass-through ──────────────────────────────────────────────────────────

  readFileSync(path: string, encoding: string): string {
    return realReadFileSync(path, encoding as BufferEncoding) as string;
  }

  existsSync(path: string): boolean {
    return realExistsSync(path);
  }
}

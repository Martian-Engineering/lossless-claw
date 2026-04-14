import { spawnSync } from "node:child_process";
import type { Command } from "commander";
import { resolveOpenclawStateDir, type LcmConfig } from "../db/config.js";
import {
  buildLcmRestoreCliCommand,
  listLcmRestoreTargets,
  type LcmRestoreExecutionResult,
  restoreLcmDatabaseFromBackup,
} from "./lcm-db-restore.js";

type LcmCliLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

type GatewayCommandResult = {
  stdout: string;
  stderr: string;
};

function writeLine(line = "", writer: Pick<NodeJS.WriteStream, "write"> = process.stdout): void {
  writer.write(`${line}\n`);
}

function readCommandOutput(stream: string | Buffer | null | undefined): string {
  if (typeof stream === "string") {
    return stream.trim();
  }
  if (Buffer.isBuffer(stream)) {
    return stream.toString("utf8").trim();
  }
  return "";
}

/**
 * Run a nested OpenClaw CLI command using the current process invocation.
 */
function runNestedOpenClawCommand(args: string[]): GatewayCommandResult {
  const scriptPath = process.argv[1]?.trim();
  const command = scriptPath ? process.execPath : "openclaw";
  const commandArgs = scriptPath ? [scriptPath, ...args] : args;
  const result = spawnSync(command, commandArgs, {
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = readCommandOutput(result.stdout);
  const stderr = readCommandOutput(result.stderr);
  if (result.status !== 0) {
    const details = [stderr, stdout].filter(Boolean).join("\n");
    throw new Error(details || `openclaw ${args.join(" ")} failed with exit code ${result.status ?? 1}`);
  }
  return { stdout, stderr };
}

/**
 * Render the available restore targets as exact CLI invocations.
 */
function renderRestoreTargets(config: LcmConfig, writer: Pick<NodeJS.WriteStream, "write"> = process.stdout): void {
  const targets = listLcmRestoreTargets(config.databasePath);
  const stateDir = resolveOpenclawStateDir(process.env);
  writeLine("Lossless Claw Restore", writer);
  writeLine("", writer);
  writeLine(`State dir: ${stateDir}`, writer);
  if (targets.length === 0) {
    writeLine("No restore snapshots were found for the configured LCM database.", writer);
    writeLine("Create one first with `/lossless backup` or `/lossless rotate`.", writer);
    return;
  }

  writeLine("Available targets:", writer);
  for (const target of targets) {
    const label = target.kind === "latest" ? "latest rotate backup" : target.label;
    writeLine(`- ${target.name} (${label})`, writer);
    writeLine(`  ${buildLcmRestoreCliCommand({ target: target.name, stateDir })}`, writer);
  }
}

function buildRestoreFailureMessage(error: unknown, restore: LcmRestoreExecutionResult | null): string {
  const baseMessage = error instanceof Error ? error.message : String(error);
  if (!restore) {
    return baseMessage;
  }
  const preservedState = [
    restore.currentBackupPath ? `Previous DB backup: ${restore.currentBackupPath}` : null,
    restore.walArchivePath ? `Archived WAL: ${restore.walArchivePath}` : null,
    restore.shmArchivePath ? `Archived SHM: ${restore.shmArchivePath}` : null,
  ].filter((line): line is string => Boolean(line));
  if (preservedState.length === 0) {
    return baseMessage;
  }
  return [baseMessage, ...preservedState].join("\n");
}

/**
 * Execute the offline restore orchestration around the selected SQLite snapshot.
 */
export function runLcmRestoreCli(params: {
  config: LcmConfig;
  target: string;
  logger?: LcmCliLogger;
  writer?: Pick<NodeJS.WriteStream, "write">;
}): void {
  const writer = params.writer ?? process.stdout;
  const target = listLcmRestoreTargets(params.config.databasePath).find(
    (candidate) => candidate.name === params.target,
  );
  if (!target) {
    throw new Error(`Unknown restore target "${params.target}". Run \`openclaw lossless restore\` to list available targets.`);
  }

  writeLine("Lossless Claw Restore", writer);
  writeLine("", writer);
  writeLine(`Target: ${target.name}`, writer);
  writeLine(`Snapshot: ${target.backupPath}`, writer);
  writeLine(`Database: ${params.config.databasePath}`, writer);
  writeLine(`State dir: ${resolveOpenclawStateDir(process.env)}`, writer);
  writeLine("", writer);

  let restore: LcmRestoreExecutionResult | null = null;
  try {
    params.logger?.info?.(`[lcm] restore-cli: stopping gateway for target=${target.name}`);
    writeLine("1. Stopping gateway...", writer);
    runNestedOpenClawCommand(["gateway", "stop", "--json"]);

    params.logger?.info?.(`[lcm] restore-cli: restoring snapshot ${target.backupPath}`);
    writeLine("2. Restoring snapshot...", writer);
    restore = restoreLcmDatabaseFromBackup({
      databasePath: params.config.databasePath,
      target,
    });
    writeLine(`   quick_check: ${restore.quickCheck}`, writer);
    if (restore.currentBackupPath) {
      writeLine(`   archived current db: ${restore.currentBackupPath}`, writer);
    }
    if (restore.walArchivePath) {
      writeLine(`   archived wal: ${restore.walArchivePath}`, writer);
    }
    if (restore.shmArchivePath) {
      writeLine(`   archived shm: ${restore.shmArchivePath}`, writer);
    }

    params.logger?.info?.(`[lcm] restore-cli: starting gateway after target=${target.name}`);
    writeLine("3. Starting gateway...", writer);
    runNestedOpenClawCommand(["gateway", "start", "--json"]);

    writeLine("4. Verifying gateway health...", writer);
    runNestedOpenClawCommand(["gateway", "status", "--require-rpc", "--json"]);
    writeLine("", writer);
    writeLine("Restore completed and gateway health checks passed.", writer);
  } catch (error) {
    throw new Error(buildRestoreFailureMessage(error, restore));
  }
}

/**
 * Register the `openclaw lossless` plugin CLI surface.
 */
export function registerLcmCli(params: {
  program: Command;
  config: LcmConfig;
  logger?: LcmCliLogger;
}): void {
  const lossless = params.program
    .command("lossless")
    .description("Operate Lossless Claw maintenance commands outside the running gateway");

  lossless
    .command("restore [target]")
    .description("List restorable snapshots or restore one safely with gateway orchestration")
    .action((target?: string) => {
      if (!target?.trim()) {
        renderRestoreTargets(params.config);
        return;
      }
      runLcmRestoreCli({
        config: params.config,
        target: target.trim(),
        logger: params.logger,
      });
    });
}

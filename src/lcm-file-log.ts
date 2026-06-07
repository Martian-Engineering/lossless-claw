import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { IndependentLogFileConfig } from "./db/config.js";

const LOG_PREFIX = "lossless-claw";
const LOG_SUFFIX = ".log";
const POSIX_OPENCLAW_TMP_DIR = "/tmp/openclaw";
const MAX_LOG_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_ROTATED_LOG_FILES = 5;

export type LcmFileLogLevel = "info" | "warn" | "error" | "debug";

type LcmFileLogger = {
  write: (level: LcmFileLogLevel, message: string) => boolean;
};

export type IndependentLogRedactionConfig = {
  mode?: "off" | "tools";
  patterns?: string[];
};

type OpenClawRedactor = (value: string, redaction?: IndependentLogRedactionConfig) => string;

let openClawRedactor: OpenClawRedactor | undefined = loadOpenClawRedactor();

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function rollingPathForDate(dir: string, date: Date): string {
  return path.join(dir, `${LOG_PREFIX}-${formatLocalDate(date)}${LOG_SUFFIX}`);
}

function defaultRollingPath(date = new Date()): string {
  return rollingPathForDate(resolvePreferredOpenClawTmpDir(), date);
}

function isRollingPath(file: string): boolean {
  const base = path.basename(file);
  return /^lossless-claw-\d{4}-\d{2}-\d{2}\.log$/.test(base);
}

function isRollingLogSegmentPath(file: string): boolean {
  const base = path.basename(file);
  return /^lossless-claw-\d{4}-\d{2}-\d{2}(?:\.[1-5])?\.log$/.test(base);
}

function resolveActiveLogFile(file: string): string {
  const expandedFile = expandHomePrefix(file);
  if (!isRollingPath(expandedFile)) {
    return expandedFile;
  }
  return rollingPathForDate(path.dirname(expandedFile), new Date());
}

function expandHomePrefix(file: string): string {
  if (file === "~") {
    return os.homedir();
  }
  if (file.startsWith("~/")) {
    return path.join(os.homedir(), file.slice(2));
  }
  return file;
}

function resolvePreferredOpenClawTmpDir(): string {
  if (process.platform === "win32") {
    return path.join(os.tmpdir(), "openclaw");
  }

  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  const fallbackDir = path.join(os.tmpdir(), `openclaw-${uid}`);
  const ensureTrustedFallbackDir = (): string => {
    fs.mkdirSync(fallbackDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(fallbackDir, 0o700);
    const stat = fs.lstatSync(fallbackDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Unsafe fallback OpenClaw temp dir: ${fallbackDir}`);
    }
    return fallbackDir;
  };

  try {
    let stat: fs.Stats | undefined;
    try {
      stat = fs.lstatSync(POSIX_OPENCLAW_TMP_DIR);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
      fs.mkdirSync(POSIX_OPENCLAW_TMP_DIR, { recursive: true, mode: 0o700 });
      stat = fs.lstatSync(POSIX_OPENCLAW_TMP_DIR);
    }
    if (isTrustedExistingOpenClawTmpDir(stat, uid)) {
      return POSIX_OPENCLAW_TMP_DIR;
    }
  } catch {
    // Fall back below.
  }

  return ensureTrustedFallbackDir();
}

function isTrustedExistingOpenClawTmpDir(stat: fs.Stats, uid: number | "user"): boolean {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    return false;
  }
  if (typeof uid === "number" && stat.uid !== uid) {
    return false;
  }
  return (stat.mode & 0o077) === 0;
}

function pruneOldRollingLogs(dir: string): void {
  try {
    const cutoff = Date.now() - MAX_LOG_AGE_MS;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) {
        continue;
      }
      if (!isRollingLogSegmentPath(entry.name)) {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      try {
        if (fs.statSync(fullPath).mtimeMs < cutoff) {
          fs.rmSync(fullPath, { force: true });
        }
      } catch {
        // Ignore pruning failures.
      }
    }
  } catch {
    // Ignore missing dir or read errors.
  }
}

function getCurrentLogFileBytes(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function rotatedLogPath(file: string, index: number): string {
  const ext = path.extname(file);
  const base = file.slice(0, file.length - ext.length);
  return `${base}.${index}${ext}`;
}

function rotateLogFile(file: string): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.rmSync(rotatedLogPath(file, MAX_ROTATED_LOG_FILES), { force: true });
    for (let index = MAX_ROTATED_LOG_FILES - 1; index >= 1; index -= 1) {
      const from = rotatedLogPath(file, index);
      if (fs.existsSync(from)) {
        fs.renameSync(from, rotatedLogPath(file, index + 1));
      }
    }
    if (fs.existsSync(file)) {
      fs.renameSync(file, rotatedLogPath(file, 1));
    }
    return true;
  } catch {
    return false;
  }
}

function loadOpenClawRedactor(): OpenClawRedactor | undefined {
  try {
    const require = createRequire(import.meta.url);
    const loggingCore = require("openclaw/plugin-sdk/logging-core") as {
      redactSensitiveText?: unknown;
    };
    if (typeof loggingCore.redactSensitiveText === "function") {
      return loggingCore.redactSensitiveText as OpenClawRedactor;
    }
  } catch {
    // OpenClaw is an optional peer; package tests and tooling run without it.
  }
  return undefined;
}

function redactionPattern(rawPattern: string): RegExp | undefined {
  try {
    const match = rawPattern.match(/^\/(.+)\/([dgimsuvy]*)$/);
    if (match) {
      const flags = match[2].includes("g") ? match[2] : `${match[2]}g`;
      return new RegExp(match[1], flags);
    }
    return new RegExp(rawPattern, "gi");
  } catch {
    return undefined;
  }
}

function fallbackRedactSensitiveText(
  value: string,
  redaction?: IndependentLogRedactionConfig,
): string {
  if (redaction?.mode === "off") {
    return value;
  }

  let next = value
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{10,}\b/g, "[REDACTED]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]")
    .replace(/\b(?:sk|rk|pk)[-_][A-Za-z0-9_-]{10,}\b/g, "[REDACTED]")
    .replace(/\btoken=([^\s]+)/gi, "token=[REDACTED]")
    .replace(/"token"\s*:\s*"[^"]+"/gi, '"token":"[REDACTED]"');

  for (const rawPattern of redaction?.patterns ?? []) {
    const pattern = redactionPattern(rawPattern);
    if (pattern) {
      next = next.replace(pattern, "[REDACTED]");
    }
  }
  return next;
}

function redactSensitiveText(value: string, redaction?: IndependentLogRedactionConfig): string {
  return (openClawRedactor ?? fallbackRedactSensitiveText)(value, redaction);
}

function appendRegularFileSync(file: string, content: string): boolean {
  let fd: number | undefined;
  try {
    const stat = fs.existsSync(file) ? fs.lstatSync(file) : undefined;
    if (stat?.isSymbolicLink() || stat?.isDirectory()) {
      return false;
    }
    const flags =
      fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_APPEND |
      (fs.constants.O_NOFOLLOW ?? 0);
    fd = fs.openSync(file, flags, 0o600);
    if (!fs.fstatSync(fd).isFile()) {
      return false;
    }
    fs.writeSync(fd, content, undefined, "utf8");
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close failures for the best-effort log sink.
      }
    }
  }
}

export function createIndependentLcmFileLogger(
  config: IndependentLogFileConfig,
  redaction?: IndependentLogRedactionConfig,
): LcmFileLogger | undefined {
  if (!config.enabled) {
    return undefined;
  }

  let configuredFile: string;
  let rollingFile: boolean;
  let activeFile: string;
  let currentFileBytes: number;
  try {
    configuredFile = config.file?.trim() || defaultRollingPath();
    rollingFile = isRollingPath(expandHomePrefix(configuredFile));
    activeFile = resolveActiveLogFile(configuredFile);
    fs.mkdirSync(path.dirname(activeFile), { recursive: true, mode: 0o700 });
    if (rollingFile) {
      pruneOldRollingLogs(path.dirname(activeFile));
    }
    currentFileBytes = getCurrentLogFileBytes(activeFile);
  } catch {
    return undefined;
  }

  return {
    write(level, message) {
      try {
        const nextActiveFile = resolveActiveLogFile(configuredFile);
        if (nextActiveFile !== activeFile) {
          activeFile = nextActiveFile;
          fs.mkdirSync(path.dirname(activeFile), { recursive: true, mode: 0o700 });
          if (rollingFile) {
            pruneOldRollingLogs(path.dirname(activeFile));
          }
          currentFileBytes = getCurrentLogFileBytes(activeFile);
        }

        const record = {
          time: new Date().toISOString(),
          level,
          plugin: "lossless-claw",
          message: redactSensitiveText(message, redaction),
        };
        const payload = `${JSON.stringify(record)}\n`;
        const payloadBytes = Buffer.byteLength(payload, "utf8");
        if (currentFileBytes > 0 && currentFileBytes + payloadBytes > config.maxFileBytes) {
          if (rotateLogFile(activeFile)) {
            currentFileBytes = getCurrentLogFileBytes(activeFile);
          }
        }
        const appended = appendRegularFileSync(activeFile, payload);
        if (!appended) {
          return false;
        }
        currentFileBytes += payloadBytes;
        return true;
      } catch {
        // Logging must never affect Lossless runtime behavior.
        return false;
      }
    },
  };
}

export const __testing = {
  defaultRollingPath,
  isTrustedExistingOpenClawTmpDir,
  resetOpenClawRedactor: () => {
    openClawRedactor = loadOpenClawRedactor();
  },
  resolveActiveLogFile,
  setOpenClawRedactor: (redactor: OpenClawRedactor | undefined) => {
    openClawRedactor = redactor;
  },
};

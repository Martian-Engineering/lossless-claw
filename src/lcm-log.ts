import type { OpenClawPluginApi } from "./openclaw-bridge.js";
import type { LcmDependencies } from "./types.js";
import type { LcmConfig } from "./db/config.js";
import {
  createIndependentLcmFileLogger,
  type IndependentLogRedactionConfig,
  type LcmFileLogLevel,
} from "./lcm-file-log.js";

export type LcmLogger = LcmDependencies["log"];

/** Silent logger used when a caller does not provide an explicit sink. */
export const NOOP_LCM_LOGGER: LcmLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  hostInfo: () => {},
  hostWarn: () => {},
};

/** Format unknown failures into stable one-line log text. */
export function describeLogError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function teeLogger(
  base: LcmLogger,
  fileLogger: ReturnType<typeof createIndependentLcmFileLogger>,
  options: { writeDebugToFile: boolean },
): LcmLogger {
  const fileOnly = (level: LcmFileLogLevel, message: string, emit: (message: string) => void) => {
    if (!fileLogger) {
      emit(message);
      return;
    }
    if (!fileLogger.write(level, message)) {
      emit(message);
    }
  };
  const hostAndFile = (
    level: LcmFileLogLevel,
    message: string,
    emit: (message: string) => void,
  ) => {
    emit(message);
    fileLogger?.write(level, message);
  };
  return {
    info: (message) => fileOnly("info", message, base.info),
    warn: (message) => hostAndFile("warn", message, base.warn),
    error: (message) => hostAndFile("error", message, base.error),
    debug: (message) => {
      if (!fileLogger) {
        base.debug(message);
        return;
      }
      if (options.writeDebugToFile) {
        if (!fileLogger.write("debug", message)) {
          base.debug(message);
        }
      }
    },
    hostInfo: (message) => hostAndFile("info", message, base.info),
    hostWarn: (message) => hostAndFile("warn", message, base.warn),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readRuntimeConfigCandidates(api: OpenClawPluginApi): Record<string, unknown>[] {
  const candidates: Record<string, unknown>[] = [];
  if (isRecord(api.config)) {
    candidates.push(api.config);
  }
  const runtimeConfig = api.runtime?.config;
  if (typeof runtimeConfig?.current === "function") {
    const current = runtimeConfig.current();
    if (isRecord(current)) {
      candidates.push(current);
    }
  }
  return candidates;
}

function readOpenClawRedactionConfig(
  api: OpenClawPluginApi,
  openClawConfig: unknown,
): IndependentLogRedactionConfig {
  const candidates = isRecord(openClawConfig) ? [openClawConfig] : readRuntimeConfigCandidates(api);
  const loggingConfig = candidates
    .map((candidate) => candidate.logging)
    .find(isRecord);
  const redactSensitive = loggingConfig?.redactSensitive;
  const patterns = Array.isArray(loggingConfig?.redactPatterns)
    ? loggingConfig.redactPatterns.filter((pattern): pattern is string => typeof pattern === "string")
    : undefined;
  return {
    mode: redactSensitive === "off" || redactSensitive === "tools" ? redactSensitive : undefined,
    patterns,
  };
}

function shouldWriteIndependentDebug(api: OpenClawPluginApi): boolean {
  const shouldLogVerbose = api.runtime?.logging?.shouldLogVerbose;
  return typeof shouldLogVerbose === "function" ? shouldLogVerbose() === true : false;
}

/** Create the LCM logger, preferring OpenClaw's runtime child logger. */
export function createLcmLogger(
  api: OpenClawPluginApi,
  config: LcmConfig,
  openClawConfig?: unknown,
): LcmLogger {
  const fileLogger = createIndependentLcmFileLogger(
    config.independentLogFile,
    readOpenClawRedactionConfig(api, openClawConfig),
  );
  const writeDebugToFile = shouldWriteIndependentDebug(api);
  const runtimeLogger = api.runtime?.logging?.getChildLogger?.({ plugin: "lossless-claw" });
  if (runtimeLogger) {
    return teeLogger(
      {
        info: (message) => runtimeLogger.info(message),
        warn: (message) => runtimeLogger.warn(message),
        error: (message) => runtimeLogger.error(message),
        debug: (message) => runtimeLogger.debug?.(message),
      },
      fileLogger,
      { writeDebugToFile },
    );
  }

  return teeLogger(
    {
      info: (message) => api.logger.info(message),
      warn: (message) => api.logger.warn(message),
      error: (message) => api.logger.error(message),
      debug: (message) => api.logger.debug?.(message),
    },
    fileLogger,
    { writeDebugToFile },
  );
}

/** Render the standard `session=… sessionKey=…` log label used across lifecycle methods. */
export function formatSessionLabel(sessionId: string, sessionKey?: string): string {
  return [
    `session=${sessionId}`,
    ...(sessionKey?.trim() ? [`sessionKey=${sessionKey.trim()}`] : []),
  ].join(" ");
}

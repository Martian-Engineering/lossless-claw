import type { OpenClawPluginApi } from "./openclaw-bridge.js";
import type { LcmDependencies } from "./types.js";

export type LcmLogger = LcmDependencies["log"];

/** Silent logger used when a caller does not provide an explicit sink. */
export const NOOP_LCM_LOGGER: LcmLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

/** Format unknown failures into stable one-line log text. */
export function describeLogError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Create the LCM logger, preferring OpenClaw's file-backed runtime logger. */
export function createLcmLogger(api: OpenClawPluginApi): LcmLogger {
  const runtimeLogger = api.runtime.logging?.getChildLogger?.({ plugin: "lossless-claw" });
  if (runtimeLogger) {
    return {
      info: (message) => runtimeLogger.info(message),
      warn: (message) => runtimeLogger.warn(message),
      error: (message) => runtimeLogger.error(message),
      debug: (message) => runtimeLogger.debug?.(message),
    };
  }

  return {
    info: (message) => api.logger.info(message),
    warn: (message) => api.logger.warn(message),
    error: (message) => api.logger.error(message),
    debug: (message) => api.logger.debug?.(message),
  };
}

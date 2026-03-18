type StartupBannerKey =
  | "plugin-loaded"
  | "compaction-model"
  | "ignore-session-patterns"
  | "stateless-session-patterns";

type StartupBannerLogState = {
  emitted: Set<StartupBannerKey>;
};

const STARTUP_BANNER_LOG_STATE = Symbol.for(
  "@martian-engineering/lossless-claw/startup-banner-log-state",
);

/** Return the process-global startup banner log state. */
function getStartupBannerLogState(): StartupBannerLogState {
  const globalState = globalThis as typeof globalThis & {
    [STARTUP_BANNER_LOG_STATE]?: StartupBannerLogState;
  };

  if (!globalState[STARTUP_BANNER_LOG_STATE]) {
    globalState[STARTUP_BANNER_LOG_STATE] = {
      emitted: new Set<StartupBannerKey>(),
    };
  }

  return globalState[STARTUP_BANNER_LOG_STATE];
}

/** Emit a startup/config banner only once per process. */
export function logStartupBannerOnce(params: {
  key: StartupBannerKey;
  log: (message: string) => void;
  message: string;
}): void {
  const state = getStartupBannerLogState();
  if (state.emitted.has(params.key)) {
    return;
  }

  state.emitted.add(params.key);
  params.log(params.message);
}

/** Reset startup/config banner dedupe state for tests. */
export function resetStartupBannerLogsForTests(): void {
  getStartupBannerLogState().emitted.clear();
}

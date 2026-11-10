import type { LcmDependencies } from "../types.js";

/** Discover canonical replay on the public SDK without raising the supported host floor. */
export async function loadCanonicalReplayReader(): Promise<LcmDependencies["readSessionTranscriptReplayGroups"]> {
  const modulePath = "openclaw/plugin-sdk/context-engine-transcript-runtime";
  let mod: { readSessionTranscriptReplayGroups?: unknown };
  try {
    mod = await import(modulePath);
  } catch (error) {
    // Only the absent public subpath is optional. A broken module or one of
    // its dependencies must still reach the existing assembly-error policy.
    if (error instanceof Error && "code" in error &&
        error.code === "ERR_PACKAGE_PATH_NOT_EXPORTED" &&
        error.message.includes("'./plugin-sdk/context-engine-transcript-runtime'")) {
      return undefined;
    }
    throw error;
  }
  const read = mod.readSessionTranscriptReplayGroups;
  if (read === undefined) return undefined;
  if (typeof read !== "function") {
    throw new TypeError("[lcm] OpenClaw readSessionTranscriptReplayGroups is not a function.");
  }
  return read as NonNullable<LcmDependencies["readSessionTranscriptReplayGroups"]>;
}

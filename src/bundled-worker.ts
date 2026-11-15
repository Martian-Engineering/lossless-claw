import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Locate a worker entry bundled next to the running plugin bundle, for example
 * dist/index.js -> dist/search-worker.js. Unbundled source runs have no such
 * file, so callers fall back to running the work in-process.
 */
export function resolveBundledWorkerUrl(fileName: string): URL | null {
  const url = new URL(`./${fileName}`, import.meta.url);
  return url.protocol === "file:" && existsSync(fileURLToPath(url)) ? url : null;
}

import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

function normalizeForComparison(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

/**
 * Resolve a stored large-file path only when it names a regular file beneath
 * the configured large-files root. This is intentionally fail-closed because
 * the returned path may be shown to the model and used by local tools.
 */
export async function resolveExposableLargeFilePath(
  largeFilesDir: string,
  storageUri: string,
): Promise<string | undefined> {
  try {
    const safeRoot = await realpath(resolve(largeFilesDir));
    const realTarget = await realpath(resolve(storageUri));
    const comparisonRoot = normalizeForComparison(safeRoot);
    const comparisonTarget = normalizeForComparison(realTarget);
    const relativePath = relative(comparisonRoot, comparisonTarget);

    if (
      relativePath === "" ||
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    ) {
      return undefined;
    }

    const targetStat = await stat(realTarget);
    return targetStat.isFile() ? realTarget : undefined;
  } catch {
    return undefined;
  }
}

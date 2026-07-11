import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const LOSSLESS_PACKAGE_NAME = "@martian-engineering/lossless-claw";
const LOSSLESS_PACKAGE_SEGMENTS = ["@martian-engineering", "lossless-claw"];

/** A discovered Lossless Claw package copy relevant to the active OpenClaw installation. */
export type LcmPackageCopy = {
  kind: "active" | "live" | "generated";
  path: string;
  version: string;
};

/** The active package plus any other installed copies and whether their versions diverge. */
export type LcmVersionDoctorScan = {
  active: LcmPackageCopy;
  shadows: LcmPackageCopy[];
  split: boolean;
};

/** Normalize the loader-provided source to the directory that contains active code. */
function normalizePackageRoot(sourcePath: string): string {
  const absolutePath = resolve(sourcePath);
  if (!existsSync(absolutePath)) {
    return absolutePath;
  }
  try {
    return statSync(absolutePath).isDirectory() ? absolutePath : dirname(absolutePath);
  } catch {
    return absolutePath;
  }
}

/** Read only a valid Lossless Claw manifest from a candidate package root. */
function readPackageCopy(
  packageRoot: string,
  kind: LcmPackageCopy["kind"],
): LcmPackageCopy | null {
  const packagePath = join(packageRoot, "package.json");
  if (!existsSync(packagePath)) {
    return null;
  }
  try {
    const manifest = JSON.parse(readFileSync(packagePath, "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    return manifest.name === LOSSLESS_PACKAGE_NAME && typeof manifest.version === "string"
      ? { kind, path: packageRoot, version: manifest.version }
      : null;
  } catch {
    return null;
  }
}

/** Resolve generated-project package roots without recursively walking node_modules. */
function listGeneratedProjectRoots(stateDir: string): string[] {
  const projectsRoot = join(stateDir, "npm", "projects");
  if (!existsSync(projectsRoot)) {
    return [];
  }
  try {
    return readdirSync(projectsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(projectsRoot, entry.name, "node_modules", ...LOSSLESS_PACKAGE_SEGMENTS));
  } catch {
    return [];
  }
}

/** Prefer real paths for deduplication while retaining missing paths for reporting. */
function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Scan the active package and OpenClaw's fixed live and generated-project install locations. */
export function scanLcmVersionCopies(params: {
  activeSourcePath: string;
  activeVersion: string;
  stateDir: string;
}): LcmVersionDoctorScan {
  const activePath = normalizePackageRoot(params.activeSourcePath);
  const active: LcmPackageCopy = {
    kind: "active",
    path: activePath,
    version: params.activeVersion,
  };
  const activeCanonicalPath = canonicalPath(activePath);
  const candidates = [
    {
      kind: "live" as const,
      path: join(params.stateDir, "node_modules", ...LOSSLESS_PACKAGE_SEGMENTS),
    },
    {
      kind: "live" as const,
      path: join(params.stateDir, "extensions", "node_modules", ...LOSSLESS_PACKAGE_SEGMENTS),
    },
    ...listGeneratedProjectRoots(params.stateDir).map((path) => ({
      kind: "generated" as const,
      path,
    })),
  ];
  const seen = new Set([activeCanonicalPath]);
  const shadows: LcmPackageCopy[] = [];

  for (const candidate of candidates) {
    const copy = readPackageCopy(candidate.path, candidate.kind);
    if (!copy) {
      continue;
    }
    const canonical = canonicalPath(copy.path);
    if (seen.has(canonical)) {
      continue;
    }
    seen.add(canonical);
    shadows.push(copy);
  }

  shadows.sort((left, right) => left.path.localeCompare(right.path));
  return {
    active,
    shadows,
    split: shadows.some((copy) => copy.version !== active.version),
  };
}

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  resolveLcmConfigWithDiagnostics,
  type LcmConfig,
  type LcmConfigDiagnostics,
} from "../db/config.js";
import { CliError } from "./output.js";

const LOSSLESS_PLUGIN_ID = "lossless-claw";

type JsonRecord = Record<string, unknown>;

// Load the packaged manifest in both source-test and dist/cli.js layouts.
function loadConfigSchema(): JsonRecord {
  const candidates = [
    new URL("../openclaw.plugin.json", import.meta.url),
    new URL("../../openclaw.plugin.json", import.meta.url),
  ];
  const manifestUrl = candidates.find((candidate) => existsSync(candidate));
  if (!manifestUrl) {
    throw new CliError(
      "CONFIG_SCHEMA_NOT_FOUND",
      "Could not locate the packaged Lossless plugin manifest.",
      4,
    );
  }
  const parsed = JSON.parse(readFileSync(manifestUrl, "utf8")) as unknown;
  const schema = asRecord(asRecord(parsed)?.configSchema);
  if (!schema) {
    throw new CliError("CONFIG_SCHEMA_INVALID", "Lossless plugin manifest has no configSchema.", 4);
  }
  return schema;
}

const CONFIG_SCHEMA = loadConfigSchema();

export type ConfigView = {
  configPath: string;
  raw: JsonRecord;
  effective: LcmConfig;
  diagnostics: LcmConfigDiagnostics;
  environmentOverrides: string[];
};

export type ConfigValueView = {
  path: string;
  isSet: boolean;
  rawValue: unknown;
  effectiveValue: unknown;
};

export type ConfigSetResult = {
  path: string;
  oldValue: unknown;
  newValue: unknown;
  configPath: string;
  backupPath: string;
};

type SetConfigOptions = {
  now?: () => Date;
};

// Narrow arbitrary parsed JSON values to objects with own properties.
function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

// Parse a JSON config file without accepting JSON5 syntax or partial values.
function readRootConfig(configPath: string): JsonRecord {
  if (!existsSync(configPath)) {
    throw new CliError("CONFIG_NOT_FOUND", `OpenClaw config not found at ${configPath}.`, 3, {
      configPath,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new CliError(
      "CONFIG_PARSE_FAILED",
      `OpenClaw config must be strict JSON for Lossless CLI editing: ${
        error instanceof Error ? error.message : String(error)
      }`,
      4,
      { configPath },
    );
  }
  const root = asRecord(parsed);
  if (!root) {
    throw new CliError("CONFIG_PARSE_FAILED", "OpenClaw config root must be an object.", 4, {
      configPath,
    });
  }
  return root;
}

// Read an optional object property and reject incompatible config shapes.
function optionalRecord(parent: JsonRecord, key: string, configPath: string): JsonRecord | undefined {
  const value = parent[key];
  if (value === undefined) {
    return undefined;
  }
  const record = asRecord(value);
  if (!record) {
    throw new CliError(
      "CONFIG_SHAPE_INVALID",
      `OpenClaw config property ${key} must be an object.`,
      4,
      { configPath, key },
    );
  }
  return record;
}

// Extract only the Lossless plugin config so unrelated OpenClaw secrets never escape.
function extractLosslessConfig(root: JsonRecord, configPath: string): JsonRecord {
  const plugins = optionalRecord(root, "plugins", configPath);
  const entries = plugins ? optionalRecord(plugins, "entries", configPath) : undefined;
  const entry = entries ? optionalRecord(entries, LOSSLESS_PLUGIN_ID, configPath) : undefined;
  return entry ? optionalRecord(entry, "config", configPath) ?? {} : {};
}

// Return environment variable names that can affect effective Lossless values, never values.
function listEnvironmentOverrides(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env)
    .filter((key) => key.startsWith("LCM_") || key === "TZ")
    .filter((key) => typeof env[key] === "string")
    .sort();
}

/** Read the raw plugin config and effective runtime values without exposing other config sections. */
export function readConfigView(
  configPath: string,
  env: NodeJS.ProcessEnv = process.env,
): ConfigView {
  const raw = extractLosslessConfig(readRootConfig(configPath), configPath);
  const resolved = resolveLcmConfigWithDiagnostics(env, raw);
  return {
    configPath,
    raw,
    effective: resolved.config,
    diagnostics: resolved.diagnostics,
    environmentOverrides: listEnvironmentOverrides(env),
  };
}

// Split and validate a dot path before reading or mutating objects.
function parseConfigPath(path: string): string[] {
  const segments = path.split(".");
  if (segments.some((segment) => !segment || segment.trim() !== segment)) {
    throw new CliError("CONFIG_VALIDATION_FAILED", "Config path must use non-empty dot segments.", 4, {
      path,
    });
  }
  return segments;
}

// Resolve a path through own properties only.
function readValueAtPath(root: JsonRecord, segments: string[]): { found: boolean; value: unknown } {
  let current: unknown = root;
  for (const segment of segments) {
    const record = asRecord(current);
    if (!record || !Object.hasOwn(record, segment)) {
      return { found: false, value: null };
    }
    current = record[segment];
  }
  return { found: true, value: current };
}

// Map accepted legacy aliases to their effective runtime field names.
function effectivePathSegments(segments: string[]): string[] {
  const path = segments.join(".");
  if (path === "dbPath") {
    return ["databasePath"];
  }
  if (path === "largeFileThresholdTokens") {
    return ["largeFileTokenThreshold"];
  }
  if (path === "incrementalMaxDepth") {
    return ["sweepMaxDepth"];
  }
  return segments;
}

/** Return raw and effective values for one Lossless config path. */
export function getConfigValue(view: ConfigView, path: string): ConfigValueView {
  const segments = parseConfigPath(path);
  const raw = readValueAtPath(view.raw, segments);
  const effective = readValueAtPath(
    view.effective as unknown as JsonRecord,
    effectivePathSegments(segments),
  );
  if (!raw.found && !effective.found) {
    throw new CliError("CONFIG_KEY_NOT_FOUND", `Unknown Lossless config path: ${path}.`, 3, { path });
  }
  return {
    path,
    isSet: raw.found,
    rawValue: raw.found ? raw.value : null,
    effectiveValue: effective.found ? effective.value : null,
  };
}

// Find the manifest schema node for an approved dot path.
function schemaAtPath(segments: string[]): JsonRecord | undefined {
  let schema = CONFIG_SCHEMA;
  for (const segment of segments) {
    const properties = asRecord(schema.properties);
    const next = properties?.[segment];
    const nextSchema = asRecord(next);
    if (!nextSchema) {
      return undefined;
    }
    schema = nextSchema;
  }
  return schema;
}

type SchemaValidationError = { path: string; message: string };

// Validate the JSON Schema subset used by openclaw.plugin.json.
function validateSchema(
  schema: JsonRecord,
  value: unknown,
  path = "",
): SchemaValidationError[] {
  const errors: SchemaValidationError[] = [];
  const type = schema.type;

  if (type === "object") {
    const record = asRecord(value);
    if (!record) {
      return [{ path, message: "Expected object" }];
    }
    const properties = asRecord(schema.properties) ?? {};
    const required = Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === "string")
      : [];
    for (const key of required) {
      if (!Object.hasOwn(record, key)) {
        errors.push({ path: `${path}/${key}`, message: "Required property is missing" });
      }
    }
    if (typeof schema.minProperties === "number" && Object.keys(record).length < schema.minProperties) {
      errors.push({ path, message: `Expected at least ${schema.minProperties} properties` });
    }
    for (const [key, childValue] of Object.entries(record)) {
      const childSchema = asRecord(properties[key]);
      if (!childSchema) {
        if (schema.additionalProperties === false) {
          errors.push({ path: `${path}/${key}`, message: "Unexpected property" });
        }
        continue;
      }
      errors.push(...validateSchema(childSchema, childValue, `${path}/${key}`));
    }
  } else if (type === "array") {
    if (!Array.isArray(value)) {
      return [{ path, message: "Expected array" }];
    }
    const itemSchema = asRecord(schema.items);
    if (itemSchema) {
      value.forEach((item, index) => {
        errors.push(...validateSchema(itemSchema, item, `${path}/${index}`));
      });
    }
  } else if (type === "string") {
    if (typeof value !== "string") {
      return [{ path, message: "Expected string" }];
    }
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push({ path, message: `Expected at least ${schema.minLength} characters` });
    }
  } else if (type === "boolean") {
    if (typeof value !== "boolean") {
      return [{ path, message: "Expected boolean" }];
    }
  } else if (type === "number" || type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value) || (type === "integer" && !Number.isInteger(value))) {
      return [{ path, message: type === "integer" ? "Expected integer" : "Expected number" }];
    }
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push({ path, message: `Expected value >= ${schema.minimum}` });
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push({ path, message: `Expected value <= ${schema.maximum}` });
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    errors.push({ path, message: `Expected one of ${schema.enum.map(String).join(", ")}` });
  }
  return errors;
}

// Reject include-bearing ancestors because rewriting would flatten their semantics.
function assertNoRelevantIncludes(root: JsonRecord, configPath: string): void {
  const ancestors: Array<{ label: string; value: JsonRecord | undefined }> = [{ label: "root", value: root }];
  const plugins = asRecord(root.plugins);
  const entries = asRecord(plugins?.entries);
  const entry = asRecord(entries?.[LOSSLESS_PLUGIN_ID]);
  const config = asRecord(entry?.config);
  ancestors.push(
    { label: "plugins", value: plugins },
    { label: "plugins.entries", value: entries },
    { label: `plugins.entries.${LOSSLESS_PLUGIN_ID}`, value: entry },
    { label: `plugins.entries.${LOSSLESS_PLUGIN_ID}.config`, value: config },
  );
  const include = ancestors.find(({ value }) => value && Object.hasOwn(value, "$include"));
  if (include) {
    throw new CliError(
      "CONFIG_INCLUDE_UNSUPPORTED",
      `Lossless CLI config writes do not flatten $include at ${include.label}.`,
      4,
      { configPath, includePath: include.label },
    );
  }
}

// Create one object property while rejecting existing scalar or array shapes.
function getOrCreateRecord(parent: JsonRecord, key: string, configPath: string): JsonRecord {
  if (parent[key] === undefined) {
    parent[key] = {};
  }
  const record = asRecord(parent[key]);
  if (!record) {
    throw new CliError(
      "CONFIG_SHAPE_INVALID",
      `Cannot create Lossless config below non-object property ${key}.`,
      4,
      { configPath, key },
    );
  }
  return record;
}

// Set one nested property after the manifest path has been validated.
function setValueAtPath(root: JsonRecord, segments: string[], value: unknown, configPath: string): unknown {
  let parent = root;
  for (const segment of segments.slice(0, -1)) {
    parent = getOrCreateRecord(parent, segment, configPath);
  }
  const finalSegment = segments.at(-1)!;
  const oldValue = Object.hasOwn(parent, finalSegment) ? parent[finalSegment] : null;
  parent[finalSegment] = value;
  return oldValue;
}

// Parse a JSON CLI value and normalize its public validation error.
function parseJsonValue(value: string, path: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new CliError(
      "CONFIG_VALIDATION_FAILED",
      `Value for ${path} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      4,
      { path },
    );
  }
}

// Validate the complete plugin config to catch both target and surrounding invalid values.
function validatePluginConfig(config: JsonRecord, path: string): void {
  const errors = validateSchema(CONFIG_SCHEMA, config).slice(0, 20);
  if (errors.length === 0) {
    return;
  }
  throw new CliError(
    "CONFIG_VALIDATION_FAILED",
    `Lossless config would be invalid after setting ${path}.`,
    4,
    { path, errors },
  );
}

// Apply runtime cross-field validation that the manifest schema cannot express.
function validateRuntimeConfig(config: JsonRecord, path: string): void {
  try {
    resolveLcmConfigWithDiagnostics({}, config);
  } catch (error) {
    throw new CliError(
      "CONFIG_VALIDATION_FAILED",
      `Lossless config would fail runtime validation after setting ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      4,
      { path },
    );
  }
}

// Convert an ISO timestamp to a filename-safe, sortable backup suffix.
function backupTimestamp(now: Date): string {
  return now.toISOString().replace(/[-:.]/g, "");
}

// Persist validated JSON through a sibling temp file and atomic rename.
function writeConfigAtomically(configPath: string, root: JsonRecord, mode: number): void {
  const tempPath = join(dirname(configPath), `.${basename(configPath)}.lcm-${process.pid}-${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    writeFileSync(tempPath, `${JSON.stringify(root, null, 2)}\n`, { flag: "wx", mode });
    chmodSync(tempPath, mode);
    descriptor = openSync(tempPath, "r+");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(tempPath, configPath);
  } catch (error) {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    rmSync(tempPath, { force: true });
    throw new CliError(
      "CONFIG_WRITE_FAILED",
      `Could not atomically replace OpenClaw config: ${
        error instanceof Error ? error.message : String(error)
      }`,
      4,
      { configPath },
    );
  }
}

/** Set one manifest-declared Lossless config value with backup-first atomic replacement. */
export function setConfigValue(
  configPath: string,
  path: string,
  jsonValue: string,
  options: SetConfigOptions = {},
): ConfigSetResult {
  const stat = lstatSync(configPath, { throwIfNoEntry: false });
  if (!stat) {
    throw new CliError("CONFIG_NOT_FOUND", `OpenClaw config not found at ${configPath}.`, 3, {
      configPath,
    });
  }
  if (stat.isSymbolicLink()) {
    throw new CliError(
      "CONFIG_SYMLINK_UNSUPPORTED",
      "Lossless CLI config writes refuse symlink targets.",
      4,
      { configPath },
    );
  }

  // Complete all parsing and validation before creating the backup or temp file.
  const root = readRootConfig(configPath);
  assertNoRelevantIncludes(root, configPath);
  const segments = parseConfigPath(path);
  const targetSchema = schemaAtPath(segments);
  if (!targetSchema) {
    throw new CliError("CONFIG_VALIDATION_FAILED", `Unknown Lossless config path: ${path}.`, 4, {
      path,
    });
  }
  const newValue = parseJsonValue(jsonValue, path);
  const targetErrors = validateSchema(targetSchema, newValue);
  if (targetErrors.length > 0) {
    throw new CliError(
      "CONFIG_VALIDATION_FAILED",
      `Value does not match the manifest schema for ${path}.`,
      4,
      { path, errors: targetErrors.slice(0, 20) },
    );
  }

  const plugins = getOrCreateRecord(root, "plugins", configPath);
  const entries = getOrCreateRecord(plugins, "entries", configPath);
  const entry = getOrCreateRecord(entries, LOSSLESS_PLUGIN_ID, configPath);
  const config = getOrCreateRecord(entry, "config", configPath);
  const oldValue = setValueAtPath(config, segments, newValue, configPath);
  validatePluginConfig(config, path);
  validateRuntimeConfig(config, path);

  const backupPath = `${configPath}.lcm-backup-${backupTimestamp((options.now ?? (() => new Date()))())}`;
  try {
    copyFileSync(configPath, backupPath, constants.COPYFILE_EXCL);
  } catch (error) {
    throw new CliError(
      "CONFIG_BACKUP_FAILED",
      `Could not create OpenClaw config backup: ${error instanceof Error ? error.message : String(error)}`,
      4,
      { configPath, backupPath },
    );
  }
  writeConfigAtomically(configPath, root, stat.mode & 0o777);

  return { path, oldValue, newValue, configPath, backupPath };
}

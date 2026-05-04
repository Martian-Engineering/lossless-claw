const PLUGIN_ID = "lossless-claw";
const ENTRY_PATH = ["plugins", "entries", PLUGIN_ID];
const CONFIG_PATH = [...ENTRY_PATH, "config"];

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function readEntry(cfg) {
  const plugins = isRecord(cfg) ? cfg.plugins : undefined;
  const entries = isRecord(plugins) ? plugins.entries : undefined;
  const entry = isRecord(entries) ? entries[PLUGIN_ID] : undefined;
  return isRecord(entry) ? entry : undefined;
}

function readConfig(cfg) {
  const config = readEntry(cfg)?.config;
  return isRecord(config) ? config : undefined;
}

function readLlmPolicy(cfg) {
  const llm = readEntry(cfg)?.llm;
  if (!isRecord(llm)) {
    return {
      allowModelOverride: false,
      allowedModels: [],
    };
  }
  return {
    allowModelOverride: llm.allowModelOverride === true,
    allowedModels: Array.isArray(llm.allowedModels) ? llm.allowedModels : [],
  };
}

function toModelRef(provider, model) {
  const modelId = readString(model);
  if (!modelId) {
    return undefined;
  }
  const slash = modelId.indexOf("/");
  if (slash > 0 && slash < modelId.length - 1) {
    const directProvider = modelId.slice(0, slash).trim();
    const directModel = modelId.slice(slash + 1).trim();
    return directProvider && directModel ? `${directProvider}/${directModel}` : undefined;
  }
  const providerId = readString(provider);
  return providerId ? `${providerId}/${modelId}` : undefined;
}

/** Collect configured Lossless summary model refs that doctor can safely allowlist. */
function collectLosslessRuntimeLlmModelRefs(cfg) {
  const config = readConfig(cfg);
  if (!config) {
    return { modelRefs: [], skipped: [] };
  }

  const modelRefs = [];
  const skipped = [];
  const addConfiguredModel = (field, model, provider, configPath) => {
    const modelId = readString(model);
    if (!modelId) {
      return;
    }
    const modelRef = toModelRef(provider, modelId);
    if (modelRef) {
      modelRefs.push({ field, modelRef, configPath });
      return;
    }
    skipped.push({
      field,
      configPath,
      reason: `${field} is a bare model without a provider; use provider/model or set the matching provider field so doctor can update plugins.entries.${PLUGIN_ID}.llm.allowedModels.`,
    });
  };

  addConfiguredModel(
    "summaryModel",
    config.summaryModel,
    config.summaryProvider,
    [...CONFIG_PATH, "summaryModel"].join("."),
  );
  addConfiguredModel(
    "largeFileSummaryModel",
    config.largeFileSummaryModel,
    config.largeFileSummaryProvider,
    [...CONFIG_PATH, "largeFileSummaryModel"].join("."),
  );

  if (Array.isArray(config.fallbackProviders)) {
    for (const [index, fallback] of config.fallbackProviders.entries()) {
      if (!isRecord(fallback)) {
        skipped.push({
          field: "fallbackProviders",
          configPath: `${[...CONFIG_PATH, "fallbackProviders"].join(".")}[${index}]`,
          reason:
            "fallbackProviders entries must be objects with provider and model before doctor can update llm.allowedModels.",
        });
        continue;
      }
      const modelRef = toModelRef(fallback.provider, fallback.model);
      if (modelRef) {
        modelRefs.push({
          field: "fallbackProviders",
          modelRef,
          configPath: `${[...CONFIG_PATH, "fallbackProviders"].join(".")}[${index}]`,
        });
      } else if (readString(fallback.model) || readString(fallback.provider)) {
        skipped.push({
          field: "fallbackProviders",
          configPath: `${[...CONFIG_PATH, "fallbackProviders"].join(".")}[${index}]`,
          reason:
            "fallbackProviders entries need both provider and model before doctor can update llm.allowedModels.",
        });
      }
    }
  }

  const seen = new Set();
  return {
    modelRefs: modelRefs.filter((entry) => {
      const key = `${entry.field}:${entry.modelRef}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    }),
    skipped,
  };
}

function collectMissingPolicyEntries(cfg) {
  const { modelRefs, skipped } = collectLosslessRuntimeLlmModelRefs(cfg);
  const policy = readLlmPolicy(cfg);
  const allowedStrings = new Set(policy.allowedModels.filter((entry) => typeof entry === "string"));
  const missingRefs = modelRefs.filter((entry) => !allowedStrings.has(entry.modelRef));
  return {
    modelRefs,
    skipped,
    missingRefs,
    missingAllowModelOverride: modelRefs.length > 0 && policy.allowModelOverride !== true,
  };
}

function hasIssueForField(cfg, field) {
  const issues = collectMissingPolicyEntries(cfg);
  return (
    issues.missingAllowModelOverride ||
    issues.missingRefs.some((entry) => entry.field === field) ||
    issues.skipped.some((entry) => entry.field === field)
  );
}

/** Doctor warning rules for Lossless runtime LLM model override policy. */
export const legacyConfigRules = [
  {
    path: [...CONFIG_PATH, "summaryModel"],
    message:
      'Lossless summaryModel uses api.runtime.llm.complete model overrides. Configure plugins.entries.lossless-claw.llm.allowModelOverride and allowedModels, or run "openclaw doctor --fix".',
    match: (_value, root) => hasIssueForField(root, "summaryModel"),
  },
  {
    path: [...CONFIG_PATH, "largeFileSummaryModel"],
    message:
      'Lossless largeFileSummaryModel uses api.runtime.llm.complete model overrides. Configure plugins.entries.lossless-claw.llm.allowModelOverride and allowedModels, or run "openclaw doctor --fix".',
    match: (_value, root) => hasIssueForField(root, "largeFileSummaryModel"),
  },
  {
    path: [...CONFIG_PATH, "fallbackProviders"],
    message:
      'Lossless fallbackProviders use api.runtime.llm.complete model overrides. Configure plugins.entries.lossless-claw.llm.allowModelOverride and allowedModels, or run "openclaw doctor --fix".',
    match: (_value, root) => hasIssueForField(root, "fallbackProviders"),
  },
];

function cloneRootWithLosslessLlm(cfg) {
  const root = isRecord(cfg) ? { ...cfg } : {};
  const plugins = isRecord(root.plugins) ? { ...root.plugins } : {};
  const entries = isRecord(plugins.entries) ? { ...plugins.entries } : {};
  const entry = isRecord(entries[PLUGIN_ID]) ? { ...entries[PLUGIN_ID] } : {};
  const llm = isRecord(entry.llm) ? { ...entry.llm } : {};

  root.plugins = plugins;
  plugins.entries = entries;
  entries[PLUGIN_ID] = entry;
  entry.llm = llm;

  return { root, llm };
}

/** Add the minimal plugin runtime LLM policy needed for configured Lossless summary models. */
export function normalizeCompatibilityConfig({ cfg }) {
  const issues = collectMissingPolicyEntries(cfg);
  if (issues.modelRefs.length === 0) {
    return { config: cfg, changes: [] };
  }

  const { root, llm } = cloneRootWithLosslessLlm(cfg);
  const changes = [];

  if (llm.allowModelOverride !== true) {
    llm.allowModelOverride = true;
    changes.push("Set plugins.entries.lossless-claw.llm.allowModelOverride = true for configured Lossless summary model overrides.");
  }

  const currentAllowed = Array.isArray(llm.allowedModels) ? [...llm.allowedModels] : [];
  const allowedStrings = new Set(currentAllowed.filter((entry) => typeof entry === "string"));
  const added = [];
  for (const { modelRef } of issues.modelRefs) {
    if (!allowedStrings.has(modelRef)) {
      currentAllowed.push(modelRef);
      allowedStrings.add(modelRef);
      added.push(modelRef);
    }
  }

  if (added.length > 0 || !Array.isArray(llm.allowedModels)) {
    llm.allowedModels = currentAllowed;
    changes.push(
      `Added plugins.entries.lossless-claw.llm.allowedModels entries for configured Lossless summary models: ${added.join(", ")}`,
    );
  }

  return { config: root, changes };
}

export { collectLosslessRuntimeLlmModelRefs };

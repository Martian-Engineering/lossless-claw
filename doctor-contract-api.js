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

function readModelOverridePolicy(cfg, policyKey) {
  const policy = readEntry(cfg)?.[policyKey];
  if (!isRecord(policy)) {
    return {
      allowModelOverride: false,
      allowedModels: [],
    };
  }
  return {
    allowModelOverride: policy.allowModelOverride === true,
    allowedModels: Array.isArray(policy.allowedModels) ? policy.allowedModels : [],
  };
}

function readLlmPolicy(cfg) {
  return readModelOverridePolicy(cfg, "llm");
}

function readSubagentPolicy(cfg) {
  return readModelOverridePolicy(cfg, "subagent");
}

function toProviderPrefixedModelRef(provider, model) {
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

function toFallbackModelRef(provider, model) {
  const providerId = readString(provider);
  const modelId = readString(model);
  return providerId && modelId ? `${providerId}/${modelId}` : undefined;
}

function uniqueModelRefs(modelRefs) {
  const seen = new Set();
  return modelRefs.filter((entry) => {
    const key = `${entry.field}:${entry.modelRef}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
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
    const modelRef = toProviderPrefixedModelRef(provider, modelId);
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
      const modelRef = toFallbackModelRef(fallback.provider, fallback.model);
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

  return {
    modelRefs: uniqueModelRefs(modelRefs),
    skipped,
  };
}

/** Collect configured Lossless expansion model refs that doctor can safely allowlist. */
function collectLosslessSubagentModelRefs(cfg) {
  const config = readConfig(cfg);
  if (!config) {
    return { modelRefs: [], skipped: [] };
  }

  const modelRefs = [];
  const skipped = [];
  const modelId = readString(config.expansionModel);
  if (modelId) {
    const modelRef = toProviderPrefixedModelRef(config.expansionProvider, modelId);
    if (modelRef) {
      modelRefs.push({
        field: "expansionModel",
        modelRef,
        configPath: [...CONFIG_PATH, "expansionModel"].join("."),
      });
    } else {
      skipped.push({
        field: "expansionModel",
        configPath: [...CONFIG_PATH, "expansionModel"].join("."),
        reason:
          `expansionModel is a bare model without a provider; use provider/model or set plugins.entries.${PLUGIN_ID}.config.expansionProvider so doctor can update plugins.entries.${PLUGIN_ID}.subagent.allowedModels.`,
      });
    }
  }

  return {
    modelRefs: uniqueModelRefs(modelRefs),
    skipped,
  };
}

function collectMissingPolicyEntries(cfg) {
  const { modelRefs, skipped } = collectLosslessRuntimeLlmModelRefs(cfg);
  const policy = readLlmPolicy(cfg);
  const allowedStrings = new Set(policy.allowedModels.filter((entry) => typeof entry === "string"));
  const missingRefs = allowedStrings.has("*")
    ? []
    : modelRefs.filter((entry) => !allowedStrings.has(entry.modelRef));
  return {
    modelRefs,
    skipped,
    missingRefs,
    missingAllowModelOverride: modelRefs.length > 0 && policy.allowModelOverride !== true,
  };
}

function collectMissingSubagentPolicyEntries(cfg) {
  const { modelRefs, skipped } = collectLosslessSubagentModelRefs(cfg);
  const policy = readSubagentPolicy(cfg);
  const allowedStrings = new Set(policy.allowedModels.filter((entry) => typeof entry === "string"));
  const missingRefs = allowedStrings.has("*")
    ? []
    : modelRefs.filter((entry) => !allowedStrings.has(entry.modelRef));
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

function hasSubagentIssueForField(cfg, field) {
  const issues = collectMissingSubagentPolicyEntries(cfg);
  return (
    issues.missingAllowModelOverride ||
    issues.missingRefs.some((entry) => entry.field === field) ||
    issues.skipped.some((entry) => entry.field === field)
  );
}

function needsPolicyRepair(issues) {
  return issues.missingAllowModelOverride || issues.missingRefs.length > 0;
}

/** Doctor warning rules for Lossless runtime LLM and subagent model override policy. */
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
  {
    path: [...CONFIG_PATH, "expansionModel"],
    message:
      'Lossless expansionModel uses delegated sub-agent model overrides. Configure plugins.entries.lossless-claw.subagent.allowModelOverride and allowedModels, or run "openclaw doctor --fix".',
    match: (_value, root) => hasSubagentIssueForField(root, "expansionModel"),
  },
];

function cloneRootWithLosslessEntry(cfg) {
  const root = isRecord(cfg) ? { ...cfg } : {};
  const plugins = isRecord(root.plugins) ? { ...root.plugins } : {};
  const entries = isRecord(plugins.entries) ? { ...plugins.entries } : {};
  const entry = isRecord(entries[PLUGIN_ID]) ? { ...entries[PLUGIN_ID] } : {};

  root.plugins = plugins;
  plugins.entries = entries;
  entries[PLUGIN_ID] = entry;

  return { root, entry };
}

function ensurePolicy(entry, policyKey) {
  const policy = isRecord(entry[policyKey]) ? { ...entry[policyKey] } : {};
  entry[policyKey] = policy;
  return policy;
}

function applyModelOverridePolicyRepair({ policy, issues, changes, policyPath, subject }) {
  if (issues.modelRefs.length === 0) {
    return;
  }

  if (policy.allowModelOverride !== true) {
    policy.allowModelOverride = true;
    changes.push(
      `Set plugins.entries.lossless-claw.${policyPath}.allowModelOverride = true for configured Lossless ${subject} model overrides.`,
    );
  }

  const currentAllowed = Array.isArray(policy.allowedModels) ? [...policy.allowedModels] : [];
  const allowedStrings = new Set(currentAllowed.filter((entry) => typeof entry === "string"));
  const added = [];
  if (!allowedStrings.has("*")) {
    for (const { modelRef } of issues.modelRefs) {
      if (!allowedStrings.has(modelRef)) {
        currentAllowed.push(modelRef);
        allowedStrings.add(modelRef);
        added.push(modelRef);
      }
    }
  }

  if (added.length > 0 || !Array.isArray(policy.allowedModels)) {
    policy.allowedModels = currentAllowed;
    changes.push(
      `Added plugins.entries.lossless-claw.${policyPath}.allowedModels entries for configured Lossless ${subject} models: ${added.join(", ")}`,
    );
  }
}

/** Add the minimal plugin policies needed for configured Lossless model overrides. */
export function normalizeCompatibilityConfig({ cfg }) {
  const issues = collectMissingPolicyEntries(cfg);
  const subagentIssues = collectMissingSubagentPolicyEntries(cfg);
  const repairRuntimeLlmPolicy = needsPolicyRepair(issues);
  const repairSubagentPolicy = needsPolicyRepair(subagentIssues);
  if (!repairRuntimeLlmPolicy && !repairSubagentPolicy) {
    return { config: cfg, changes: [] };
  }

  const { root, entry } = cloneRootWithLosslessEntry(cfg);
  const changes = [];

  if (repairRuntimeLlmPolicy) {
    applyModelOverridePolicyRepair({
      policy: ensurePolicy(entry, "llm"),
      issues,
      changes,
      policyPath: "llm",
      subject: "summary",
    });
  }
  if (repairSubagentPolicy) {
    applyModelOverridePolicyRepair({
      policy: ensurePolicy(entry, "subagent"),
      issues: subagentIssues,
      changes,
      policyPath: "subagent",
      subject: "expansion",
    });
  }

  return { config: root, changes };
}

export { collectLosslessRuntimeLlmModelRefs, collectLosslessSubagentModelRefs };

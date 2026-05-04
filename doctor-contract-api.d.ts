export type LosslessRuntimeLlmModelRef = {
  field: string;
  modelRef: string;
  configPath: string;
};

export type LosslessRuntimeLlmSkippedModelRef = {
  field: string;
  configPath: string;
  reason: string;
};

export type LegacyConfigRule = {
  path: string[];
  message: string;
  match?: (value: unknown, root: Record<string, unknown>) => boolean;
};

export const legacyConfigRules: LegacyConfigRule[];

export function normalizeCompatibilityConfig(params: { cfg: unknown }): {
  config: any;
  changes: string[];
};

export function collectLosslessRuntimeLlmModelRefs(cfg: unknown): {
  modelRefs: LosslessRuntimeLlmModelRef[];
  skipped: LosslessRuntimeLlmSkippedModelRef[];
};

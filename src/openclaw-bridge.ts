/**
 * Compatibility bridge for plugin-sdk context-engine symbols.
 *
 * This module intentionally exports only stable plugin-sdk surface area.
 */

export type {
  AnyAgentTool,
  ContextEngine,
  ContextEngineInfo,
  AssembleResult,
  CompactResult,
  IngestResult,
  IngestBatchResult,
  BootstrapResult,
  OpenClawPluginApi,
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
  SubagentSpawnPreparation,
  SubagentEndReason,
} from "openclaw/plugin-sdk";

export {
  registerContextEngine,
  type ContextEngineFactory,
} from "openclaw/plugin-sdk";

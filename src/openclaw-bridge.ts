/**
 * Bridge module for OpenClaw core imports.
 *
 * All imports from OpenClaw internals are funneled through this module.
 * When running as an installed plugin, these resolve from the `openclaw` package.
 * This makes the dependency surface explicit and easy to track.
 */

// Context engine types (from plugin SDK)
export type {
  ContextEngine,
  ContextEngineInfo,
  AssembleParams,
  AssembleResult,
  CompactParams,
  CompactResult,
  IngestParams,
  IngestResult,
  IngestBatchParams,
  IngestBatchResult,
  AfterTurnParams,
  AfterTurnResult,
  BootstrapParams,
  SubagentSpawnPreparation,
  SubagentEndReason,
} from "openclaw/plugin-sdk";

export {
  registerContextEngine,
  type ContextEngineFactory,
} from "openclaw/plugin-sdk";

// Re-export pi-agent-core message types used throughout LCM
export type {
  Message,
  ContentBlock,
  TextContentBlock,
  ToolUseContentBlock,
  ToolResultContentBlock,
} from "@mariozechner/pi-agent-core";

// Re-export pi-ai for completeSimple
export { completeSimple } from "@mariozechner/pi-ai";

/**
 * Generate openclaw.plugin.json configSchema from LcmConfig type.
 * Run: npx tsx scripts/generate-manifest.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Config schema definitions - single source of truth
// Keep in sync with src/db/config.ts LcmConfig type
const CONFIG_SCHEMA_PROPERTIES: Record<string, unknown> = {
  enabled: {
    type: "boolean",
    description: "Enable or disable the plugin",
  },
  contextThreshold: {
    type: "number",
    minimum: 0,
    maximum: 1,
    description: "Fraction of context window that triggers compaction (0.0–1.0)",
  },
  incrementalMaxDepth: {
    type: "integer",
    minimum: -1,
    description: "How deep incremental compaction goes (0 = leaf only, -1 = unlimited)",
  },
  freshTailCount: {
    type: "integer",
    minimum: 1,
    description: "Number of recent messages protected from compaction",
  },
  leafMinFanout: {
    type: "integer",
    minimum: 2,
  },
  condensedMinFanout: {
    type: "integer",
    minimum: 2,
  },
  condensedMinFanoutHard: {
    type: "integer",
    minimum: 2,
  },
  dbPath: {
    type: "string",
    description: "Path to LCM SQLite database (default: ~/.openclaw/lcm.db)",
  },
  largeFileThresholdTokens: {
    type: "integer",
    minimum: 1000,
    description: "Token threshold for treating files as 'large'",
  },
  useTokenizer: {
    type: "boolean",
    description: "Use precise tokenizer service instead of chars/4 heuristic",
  },
  proxy: {
    type: "string",
    description: "HTTP(S) proxy URL for tokenizer downloads from HuggingFace",
  },
  timezone: {
    type: "string",
    description: "IANA timezone for timestamps in summaries",
  },
  pruneHeartbeatOk: {
    type: "boolean",
    description: "Delete HEARTBEAT_OK turn cycles from LCM storage",
  },
  autocompactDisabled: {
    type: "boolean",
    description: "Disable automatic compaction",
  },
  largeFileSummaryProvider: {
    type: "string",
    description: "Provider override for large-file summarization",
  },
  largeFileSummaryModel: {
    type: "string",
    description: "Model override for large-file summarization",
  },
};

// UI hints for the control panel
const UI_HINTS: Record<string, { label: string; help: string }> = {
  contextThreshold: {
    label: "Context Threshold",
    help: "Fraction of context window that triggers compaction (0.0–1.0)",
  },
  incrementalMaxDepth: {
    label: "Incremental Max Depth",
    help: "How deep incremental compaction goes (0 = leaf only, -1 = unlimited)",
  },
  freshTailCount: {
    label: "Fresh Tail Count",
    help: "Number of recent messages protected from compaction",
  },
  dbPath: {
    label: "Database Path",
    help: "Path to LCM SQLite database (default: ~/.openclaw/lcm.db)",
  },
  useTokenizer: {
    label: "Use Precise Tokenizer",
    help: "Use HuggingFace tokenizer service instead of chars/4 heuristic",
  },
  proxy: {
    label: "Proxy URL",
    help: "HTTP(S) proxy for tokenizer downloads from HuggingFace",
  },
};

function generateManifest() {
  const manifestPath = join(import.meta.dirname, "..", "openclaw.plugin.json");
  
  // Read existing manifest
  let manifest: Record<string, unknown>;
  try {
    const raw = readFileSync(manifestPath, "utf8");
    manifest = JSON.parse(raw);
  } catch {
    manifest = {};
  }

  // Update configSchema
  manifest.configSchema = {
    type: "object",
    additionalProperties: false,
    properties: CONFIG_SCHEMA_PROPERTIES,
  };

  // Update uiHints
  manifest.uiHints = UI_HINTS;

  // Ensure basic fields exist
  if (!manifest.id) {
    manifest.id = "lossless-claw";
  }

  // Write back
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  console.log("✓ Generated openclaw.plugin.json configSchema");
  console.log(`  Properties: ${Object.keys(CONFIG_SCHEMA_PROPERTIES).join(", ")}`);
}

generateManifest();

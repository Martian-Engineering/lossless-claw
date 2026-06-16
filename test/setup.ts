import { vi } from "vitest";

vi.mock("openclaw/plugin-sdk/redact", () => ({
  redactTranscriptMessage: (message: Record<string, unknown>) => message,
}));

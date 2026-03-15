import { Type } from "@sinclair/typebox";
import type { LcmContextEngine } from "../engine.js";
import type { LcmDependencies } from "../types.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { resolveLcmConversationScope } from "./lcm-conversation-scope.js";

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Default staleness threshold in minutes */
const STALE_THRESHOLD_MINUTES = 30;

/** Parse timestamp comments from scratchpad content */
function parseSectionTimestamps(content: string): Array<{ section: string; timestamp: Date; line: number }> {
  const lines = content.split("\n");
  const results: Array<{ section: string; timestamp: Date; line: number }> = [];
  let currentSection = "";

  for (let i = 0; i < lines.length; i++) {
    const headingMatch = lines[i].trim().match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      currentSection = headingMatch[2].trim();
    }
    const tsMatch = lines[i].match(/<!-- (?:updated|written|appended): (\d{4}-\d{2}-\d{2}T[\d:.]+Z?) -->/);
    if (tsMatch && currentSection) {
      const date = new Date(tsMatch[1]);
      if (!isNaN(date.getTime())) {
        results.push({ section: currentSection, timestamp: date, line: i });
      }
    }
  }
  return results;
}

/** Check for stale sections and return warnings */
function getStalenessWarnings(content: string, thresholdMinutes: number = STALE_THRESHOLD_MINUTES): string[] {
  const now = new Date();
  const sectionTimestamps = parseSectionTimestamps(content);
  const warnings: string[] = [];

  // Group by section, take the latest timestamp per section
  const latestBySection = new Map<string, Date>();
  for (const entry of sectionTimestamps) {
    const existing = latestBySection.get(entry.section);
    if (!existing || entry.timestamp > existing) {
      latestBySection.set(entry.section, entry.timestamp);
    }
  }

  for (const [section, timestamp] of latestBySection) {
    const ageMinutes = Math.round((now.getTime() - timestamp.getTime()) / 60000);
    if (ageMinutes > thresholdMinutes) {
      warnings.push(`⚠️ Section '${section}' last updated ${ageMinutes}min ago — may be stale`);
    }
  }
  return warnings;
}

const LcmScratchpadSchema = Type.Object({
  action: Type.String({
    description:
      'Action to perform: "read" (view current scratchpad), ' +
      '"write" (overwrite entire scratchpad), ' +
      '"append" (add content to the end), ' +
      '"replace_section" (replace a specific section by header).',
    enum: ["read", "write", "append", "replace_section"],
  }),
  content: Type.Optional(
    Type.String({
      description: "New content for write/append actions, or new section content for replace_section.",
    }),
  ),
  section: Type.Optional(
    Type.String({
      description:
        'Section header to replace (for replace_section action). ' +
        'Match by heading text, e.g. "Active Context" matches "## Active Context".',
    }),
  ),
  conversationId: Type.Optional(
    Type.Number({
      description: "Conversation ID. Defaults to the current session conversation.",
    }),
  ),
});

export function createLcmScratchpadTool(input: {
  deps: LcmDependencies;
  lcm: LcmContextEngine;
  sessionId?: string;
  sessionKey?: string;
}): AnyAgentTool {
  return {
    name: "lcm_scratchpad",
    label: "LCM Scratchpad",
    description:
      "Read or update your working memory scratchpad — a living document you maintain " +
      "to track active context, nearby references, and parked items. " +
      "The scratchpad sits in the high-attention zone of your context window " +
      "(just before recent messages). Use it to keep track of what matters now.",
    parameters: LcmScratchpadSchema,
    async execute(_toolCallId, params) {
      const p = params as Record<string, unknown>;
      const action = (p.action as string).trim();
      const content = typeof p.content === "string" ? p.content : undefined;
      const section = typeof p.section === "string" ? p.section.trim() : undefined;

      const conversationStore = input.lcm.getConversationStore();
      const summaryStore = input.lcm.getSummaryStore();

      // Resolve conversation
      const scope = await resolveLcmConversationScope({
        lcm: input.lcm,
        sessionKey: input.sessionKey,
        deps: input.deps,
        params: p,
      });

      if (!scope.conversationId) {
        return jsonResult({ error: "No conversation found for this session." });
      }

      const conversationId = scope.conversationId;
      const maxTokens = input.deps.config.scratchpadMaxTokens ?? 2000;

      switch (action) {
        case "read": {
          const scratchpad = await summaryStore.getScratchpad(conversationId);
          if (!scratchpad || !scratchpad.content.trim()) {
            return jsonResult({
              content: "",
              tokenCount: 0,
              message: "Scratchpad is empty. Use action: \"write\" to initialize it.",
            });
          }
          const warnings = getStalenessWarnings(scratchpad.content);
          const result: Record<string, unknown> = {
            content: scratchpad.content,
            tokenCount: scratchpad.tokenCount,
            updatedAt: scratchpad.updatedAt.toISOString(),
          };
          if (warnings.length > 0) {
            result.stalenessWarnings = warnings;
          }
          return jsonResult(result);
        }

        case "write": {
          if (content === undefined) {
            return jsonResult({ error: "content is required for write action." });
          }

          const timestampedContent = content + `\n<!-- written: ${new Date().toISOString()} -->`;
          const tokenCount = estimateTokens(timestampedContent);
          input.deps.log.info(
            `[lcm:scratchpad] Write: ${tokenCount} tokens (max: ${maxTokens})`,
          );
          if (tokenCount > maxTokens) {
            return jsonResult({
              error: `Content exceeds scratchpad limit: ${tokenCount} tokens > ${maxTokens} max. Trim content or increase scratchpadMaxTokens.`,
            });
          }

          const scratchpad = await summaryStore.upsertScratchpad({
            conversationId,
            content: timestampedContent,
            tokenCount,
          });

          // Ensure there's a scratchpad context item
          await summaryStore.ensureScratchpadContextItem(conversationId);

          // Mark conversation as actively managed
          await conversationStore.markConversationManaged(conversationId);

          return jsonResult({
            action: "write",
            tokenCount: scratchpad.tokenCount,
            message: "Scratchpad updated.",
          });
        }

        case "append": {
          if (content === undefined) {
            return jsonResult({ error: "content is required for append action." });
          }

          const existing = await summaryStore.getScratchpad(conversationId);
          const currentContent = existing?.content ?? "";
          const appendedContent = content + `\n<!-- appended: ${new Date().toISOString()} -->`;
          const newContent = currentContent
            ? `${currentContent}\n${appendedContent}`
            : appendedContent;

          const tokenCount = estimateTokens(newContent);
          if (tokenCount > maxTokens) {
            return jsonResult({
              error: `Appended content would exceed scratchpad limit: ${tokenCount} tokens > ${maxTokens} max. Use write to replace, or collapse some items first.`,
            });
          }

          const scratchpad = await summaryStore.upsertScratchpad({
            conversationId,
            content: newContent,
            tokenCount,
          });

          await summaryStore.ensureScratchpadContextItem(conversationId);

          // Mark conversation as actively managed
          await conversationStore.markConversationManaged(conversationId);

          return jsonResult({
            action: "append",
            tokenCount: scratchpad.tokenCount,
            message: "Content appended to scratchpad.",
          });
        }

        case "replace_section": {
          input.deps.log.info(
            `[lcm:scratchpad] Replace section: "${section}"`,
          );
          if (!section) {
            return jsonResult({ error: "section is required for replace_section action." });
          }
          if (content === undefined) {
            return jsonResult({ error: "content is required for replace_section action." });
          }

          const existing = await summaryStore.getScratchpad(conversationId);
          if (!existing || !existing.content.trim()) {
            return jsonResult({
              error: "Scratchpad is empty. Use action: \"write\" to initialize it first.",
            });
          }

          const lines = existing.content.split("\n");
          const sectionLower = section.toLowerCase();

          // Find the section header
          let sectionStart = -1;
          let sectionEnd = lines.length;
          let headerLevel = 0;

          for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
            if (!headingMatch) continue;

            const level = headingMatch[1].length;
            const headingText = headingMatch[2].trim().toLowerCase();

            if (sectionStart === -1) {
              if (headingText === sectionLower) {
                sectionStart = i;
                headerLevel = level;
              }
            } else {
              // Found the next heading at same or higher level — that's where this section ends
              if (level <= headerLevel) {
                sectionEnd = i;
                break;
              }
            }
          }

          if (sectionStart === -1) {
            return jsonResult({
              error: `Section "${section}" not found in scratchpad. Available sections: ${
                lines
                  .filter((l) => l.trim().match(/^#{1,6}\s+/))
                  .map((l) => l.trim().replace(/^#{1,6}\s+/, ""))
                  .join(", ") || "(none)"
              }`,
            });
          }

          // Replace the section content (keep the header, replace everything until next section)
          const header = lines[sectionStart];
          const before = lines.slice(0, sectionStart);
          const after = lines.slice(sectionEnd);
          const timestampedSectionContent = content + `\n<!-- updated: ${new Date().toISOString()} -->`;
          const newContent = [...before, header, timestampedSectionContent, ...after].join("\n");

          const tokenCount = estimateTokens(newContent);
          if (tokenCount > maxTokens) {
            return jsonResult({
              error: `Updated content would exceed scratchpad limit: ${tokenCount} tokens > ${maxTokens} max.`,
            });
          }

          const scratchpad = await summaryStore.upsertScratchpad({
            conversationId,
            content: newContent,
            tokenCount,
          });

          // Mark conversation as actively managed
          await conversationStore.markConversationManaged(conversationId);

          return jsonResult({
            action: "replace_section",
            section,
            tokenCount: scratchpad.tokenCount,
            message: `Section "${section}" updated.`,
          });
        }

        default:
          return jsonResult({
            error: `Unknown action "${action}". Use read, write, append, or replace_section.`,
          });
      }
    },
  };
}

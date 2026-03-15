import { Type } from "@sinclair/typebox";
import type { LcmContextEngine } from "../engine.js";
import { parseRef } from "../assembler.js";
import type { LcmDependencies } from "../types.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { resolveLcmConversationScope } from "./lcm-conversation-scope.js";

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const LcmPromoteSchema = Type.Object({
  source: Type.String({
    description:
      'What to promote. Accepts a pointer ID (e.g. "ptr_abc123"), ' +
      'a summary ID (e.g. "sum_abc123"), or a context ref (e.g. "§042").',
  }),
  section: Type.Optional(
    Type.String({
      description: 'Scratchpad section to append under. Default "Promoted".',
    }),
  ),
  note: Type.Optional(
    Type.String({
      description: "Additional context to add with the promoted content.",
    }),
  ),
  collapseSource: Type.Optional(
    Type.Boolean({
      description: "Whether to collapse the source item after promoting. Default false.",
    }),
  ),
  conversationId: Type.Optional(
    Type.Number({
      description: "Conversation ID. Defaults to the current session conversation.",
    }),
  ),
});

export function createLcmPromoteTool(input: {
  deps: LcmDependencies;
  lcm: LcmContextEngine;
  sessionId?: string;
  sessionKey?: string;
}): AnyAgentTool {
  return {
    name: "lcm_promote",
    label: "LCM Promote",
    description:
      "Move an insight from any context item (pointer, summary, or context ref) " +
      "into the scratchpad's high-attention zone. Optionally collapse the source after promoting.",
    parameters: LcmPromoteSchema,
    async execute(_toolCallId, params) {
      const p = params as Record<string, unknown>;
      const source = typeof p.source === "string" ? p.source.trim() : "";
      const section = typeof p.section === "string" ? p.section.trim() : "Promoted";
      const note = typeof p.note === "string" ? p.note.trim() : undefined;
      const collapseSource = p.collapseSource === true;

      if (!source) {
        return jsonResult({ error: "source is required." });
      }

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

      // Step 1: Resolve the source
      let sourceId = source;
      let contentText = "";
      let dataText = "";
      let collapseOrdinal: number | undefined;

      if (source.startsWith("ptr_")) {
        // Pointer ID
        const pointer = await summaryStore.getPointer(source);
        if (!pointer) {
          return jsonResult({ error: `Pointer ${source} not found.` });
        }
        contentText = pointer.label;
        if (pointer.data) {
          try {
            const parsed = JSON.parse(pointer.data);
            dataText = Object.entries(parsed)
              .map(([k, v]) => `  ${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`)
              .join("\n");
          } catch {
            dataText = `  data: ${pointer.data}`;
          }
        }
      } else if (source.startsWith("sum_")) {
        // Summary ID
        const summary = await summaryStore.getSummary(source);
        if (!summary) {
          return jsonResult({ error: `Summary ${source} not found.` });
        }
        contentText = summary.content;
      } else if (source.startsWith("§")) {
        // Context ref
        const ordinal = parseRef(source);
        if (isNaN(ordinal)) {
          return jsonResult({ error: `Invalid context ref "${source}". Expected format: §XXX (hex).` });
        }

        const contextItems = await summaryStore.getContextItems(conversationId);
        const item = contextItems.find((ci) => ci.ordinal === ordinal);
        if (!item) {
          return jsonResult({ error: `Context item at ${source} (ordinal ${ordinal}) not found.` });
        }

        collapseOrdinal = ordinal;

        if (item.itemType === "message" && item.messageId != null) {
          const msg = await conversationStore.getMessageById(item.messageId);
          if (msg) {
            contentText = msg.content.length > 500 ? msg.content.slice(0, 500) + "..." : msg.content;
          } else {
            contentText = `(message ${item.messageId} not found)`;
          }
        } else if (item.itemType === "summary" && item.summaryId != null) {
          const summary = await summaryStore.getSummary(item.summaryId);
          if (summary) {
            contentText = summary.content;
          } else {
            contentText = `(summary ${item.summaryId} not found)`;
          }
        } else if (item.itemType === "pointer" && item.pointerId != null) {
          const pointer = await summaryStore.getPointer(item.pointerId);
          if (pointer) {
            contentText = pointer.label;
            sourceId = pointer.pointerId;
          } else {
            contentText = `(pointer ${item.pointerId} not found)`;
          }
        } else {
          contentText = `(${item.itemType} item)`;
        }
      } else {
        return jsonResult({
          error: 'Invalid source. Use a pointer ID (ptr_...), summary ID (sum_...), or context ref (§XXX).',
        });
      }

      // Step 2: Format the promoted content
      let promotedContent = `- [${sourceId}]: ${contentText}`;
      if (dataText) {
        promotedContent += `\n${dataText}`;
      }
      if (note) {
        promotedContent += `\n  Note: ${note}`;
      }

      // Step 3: Read current scratchpad
      const existing = await summaryStore.getScratchpad(conversationId);
      const currentContent = existing?.content ?? "";

      // Step 4/5: Append to section or create new section
      let newContent: string;
      const sectionHeader = `## ${section}`;

      if (currentContent.includes(sectionHeader)) {
        // Find the section and append to it
        const lines = currentContent.split("\n");
        const sectionLower = section.toLowerCase();
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
            if (level <= headerLevel) {
              sectionEnd = i;
              break;
            }
          }
        }

        if (sectionStart !== -1) {
          // Insert before the next section
          const before = lines.slice(0, sectionEnd);
          const after = lines.slice(sectionEnd);
          newContent = [...before, promotedContent, ...after].join("\n");
        } else {
          // Fallback: append new section
          newContent = currentContent.trimEnd() + `\n\n${sectionHeader}\n${promotedContent}`;
        }
      } else {
        // Append new section
        newContent = currentContent
          ? currentContent.trimEnd() + `\n\n${sectionHeader}\n${promotedContent}`
          : `${sectionHeader}\n${promotedContent}`;
      }

      // Step 6: Write updated scratchpad
      const tokenCount = estimateTokens(newContent);
      const maxTokens = input.deps.config.scratchpadMaxTokens ?? 2000;

      if (tokenCount > maxTokens) {
        return jsonResult({
          error: `Promoting would exceed scratchpad limit: ${tokenCount} tokens > ${maxTokens} max. Free up space first.`,
        });
      }

      await summaryStore.upsertScratchpad({
        conversationId,
        content: newContent,
        tokenCount,
      });

      await summaryStore.ensureScratchpadContextItem(conversationId);

      // Step 7: Optionally collapse the source
      if (collapseSource && collapseOrdinal != null) {
        const { randomUUID } = await import("node:crypto");
        const pointerId = `ptr_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

        await summaryStore.insertPointer({
          pointerId,
          conversationId,
          label: `Promoted to scratchpad § ${section}`,
          sourceType: "ref",
          sourceIds: [sourceId],
          tokensSaved: estimateTokens(contentText),
        });

        await summaryStore.replaceContextRangeWithPointer({
          conversationId,
          startOrdinal: collapseOrdinal,
          endOrdinal: collapseOrdinal,
          pointerId,
        });
      }

      // Mark conversation as managed
      await conversationStore.markConversationManaged(conversationId);

      return jsonResult({
        promoted: sourceId,
        section,
        scratchpadTokens: tokenCount,
        message: `Promoted [${sourceId}] to scratchpad section "${section}".${collapseSource && collapseOrdinal != null ? " Source collapsed." : ""}`,
      });
    },
  };
}

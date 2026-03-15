import crypto from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { LcmContextEngine } from "../engine.js";
import type { LcmDependencies } from "../types.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { resolveLcmConversationScope } from "./lcm-conversation-scope.js";

const LcmTemplatesSchema = Type.Object({
  action: Type.String({
    description:
      '"save" to store a named template, "get" to retrieve by name, ' +
      '"list" to show all templates, "delete" to remove, ' +
      '"expand" to get content with variable substitution.',
    enum: ["save", "get", "list", "delete", "expand"],
  }),
  name: Type.Optional(
    Type.String({
      description: "Template name (required for save, get, delete, expand).",
    }),
  ),
  content: Type.Optional(
    Type.String({
      description: "Template content (required for save).",
    }),
  ),
  language: Type.Optional(
    Type.String({
      description: 'Language hint for the template (default: "python").',
    }),
  ),
  vars: Type.Optional(
    Type.String({
      description:
        'JSON object of variable replacements for expand action. ' +
        'e.g. \'{"N_COEFFS": "30", "DPS": "80"}\'. Replaces {{VAR_NAME}} patterns.',
    }),
  ),
  conversationId: Type.Optional(
    Type.Number({
      description: "Conversation ID. Defaults to the current session conversation.",
    }),
  ),
});

export function createLcmTemplatesTool(input: {
  deps: LcmDependencies;
  lcm: LcmContextEngine;
  sessionId?: string;
  sessionKey?: string;
}): AnyAgentTool {
  return {
    name: "lcm_templates",
    label: "LCM Templates",
    description:
      "Save, retrieve, and expand named code/text templates with variable substitution. " +
      "Use for reusable computation snippets, config fragments, or boilerplate. " +
      "Supports {{VAR_NAME}} placeholder expansion.",
    parameters: LcmTemplatesSchema,
    async execute(_toolCallId, params) {
      const p = params as Record<string, unknown>;
      const action = typeof p.action === "string" ? p.action.trim() : "";

      if (!action || !["save", "get", "list", "delete", "expand"].includes(action)) {
        return jsonResult({
          error: 'Invalid action. Use "save", "get", "list", "delete", or "expand".',
        });
      }

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

      switch (action) {
        case "save": {
          const name = typeof p.name === "string" ? p.name.trim() : "";
          if (!name) {
            return jsonResult({ error: "name is required for save action." });
          }
          const content = typeof p.content === "string" ? p.content : undefined;
          if (!content) {
            return jsonResult({ error: "content is required for save action." });
          }
          const language = typeof p.language === "string" ? p.language.trim() : "python";

          const templateId = `tmpl_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

          const template = await summaryStore.saveTemplate({
            templateId,
            conversationId,
            name,
            content,
            language,
          });

          input.deps.log.info(
            `[lcm:templates] Saved template "${name}" (${template.templateId})`,
          );

          return jsonResult({
            templateId: template.templateId,
            name: template.name,
            language: template.language,
            message: `Template "${name}" saved.`,
          });
        }

        case "get": {
          const name = typeof p.name === "string" ? p.name.trim() : "";
          if (!name) {
            return jsonResult({ error: "name is required for get action." });
          }

          const template = await summaryStore.getTemplate(conversationId, name);
          if (!template) {
            return jsonResult({ error: `Template "${name}" not found.` });
          }

          return jsonResult({
            templateId: template.templateId,
            name: template.name,
            content: template.content,
            language: template.language,
            createdAt: template.createdAt.toISOString(),
          });
        }

        case "list": {
          const templates = await summaryStore.listTemplates(conversationId);

          if (templates.length === 0) {
            return jsonResult({
              templates: [],
              message: 'No templates saved. Use action: "save" to create one.',
            });
          }

          return jsonResult({
            templates: templates.map((t) => ({
              templateId: t.templateId,
              name: t.name,
              language: t.language,
              createdAt: t.createdAt.toISOString(),
            })),
            message: `${templates.length} template(s) available.`,
          });
        }

        case "delete": {
          const name = typeof p.name === "string" ? p.name.trim() : "";
          if (!name) {
            return jsonResult({ error: "name is required for delete action." });
          }

          const deleted = await summaryStore.deleteTemplate(conversationId, name);
          if (!deleted) {
            return jsonResult({ error: `Template "${name}" not found.` });
          }

          input.deps.log.info(`[lcm:templates] Deleted template "${name}"`);

          return jsonResult({
            deleted: true,
            name,
            message: `Template "${name}" deleted.`,
          });
        }

        case "expand": {
          const name = typeof p.name === "string" ? p.name.trim() : "";
          if (!name) {
            return jsonResult({ error: "name is required for expand action." });
          }

          const template = await summaryStore.getTemplate(conversationId, name);
          if (!template) {
            return jsonResult({ error: `Template "${name}" not found.` });
          }

          let result = template.content;
          let varsApplied = 0;

          if (typeof p.vars === "string" && p.vars.trim()) {
            let vars: Record<string, string>;
            try {
              vars = JSON.parse(p.vars);
            } catch {
              return jsonResult({ error: "vars must be a valid JSON object." });
            }

            for (const [key, value] of Object.entries(vars)) {
              const before = result;
              result = result.replaceAll(`{{${key}}}`, String(value));
              if (result !== before) varsApplied++;
            }
          }

          return jsonResult({
            name: template.name,
            language: template.language,
            content: result,
            varsApplied,
            message: `Template "${name}" expanded${varsApplied > 0 ? ` with ${varsApplied} variable(s)` : ""}.`,
          });
        }

        default:
          return jsonResult({
            error: `Unknown action "${action}". Use save, get, list, delete, or expand.`,
          });
      }
    },
  };
}

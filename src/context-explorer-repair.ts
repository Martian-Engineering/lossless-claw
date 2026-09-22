import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { OpenClawPluginApi, PluginSessionActionContext } from "./openclaw-bridge.js";
import type { LcmConfig } from "./db/config.js";
import type { LcmDependencies } from "./types.js";
import type { LcmSummarizeFn } from "./summarize.js";
import { withExclusiveDatabaseLock } from "./transaction-mutex.js";
import { CompactionMaintenanceStore } from "./store/compaction-maintenance-store.js";
import { getDoctorSummaryStats, loadDoctorTargets } from "./plugin/lcm-doctor-shared.js";
import { buildDoctorApplySafetyPreflight, loadDoctorApplyRepairMetrics } from "./plugin/lcm-command.js";
import { applyScopedDoctorRepair } from "./plugin/lcm-doctor-apply.js";

export type ExplorerRepairPlan = {
  token: string; count: number; requiresOffline: boolean; reasons: string[];
};
export type ExplorerRepairResult = { repaired: number; unchanged: number; skipped: number };
type Options = { config: LcmConfig; deps?: LcmDependencies; runtimeConfig?: unknown; summarize?: LcmSummarizeFn };
const fingerprint = (db: DatabaseSync, targets: ReturnType<typeof loadDoctorTargets>) => {
  const hash = createHash("sha256").update(JSON.stringify(targets));
  // Source edits during a model call must not be silently overwritten either.
  for (const target of targets) {
    hash.update(JSON.stringify(db.prepare(`SELECT m.message_id, m.content FROM summary_messages sm
      JOIN messages m ON m.message_id = sm.message_id WHERE sm.summary_id = ? ORDER BY sm.ordinal`)
      .all(target.summaryId)));
    hash.update(JSON.stringify(db.prepare(`SELECT s.summary_id, s.content FROM summary_parents p
      JOIN summaries s ON s.summary_id = p.parent_summary_id WHERE p.summary_id = ? ORDER BY p.ordinal`)
      .all(target.summaryId)));
  }
  return hash.digest("hex");
};

/** An explicit write surface; never invoked by polling or read-only diagnostics. */
export function registerContextExplorerRepair(api: OpenClawPluginApi, getDb: () => Promise<DatabaseSync>, options: Options) {
  type Plan = ExplorerRepairPlan & { sessionKey: string; connId?: string; conversationId: number;
    fingerprint: string; summaryIds: string[]; expires: number };
  const plans = new Map<string, Plan>();
  const running = new Set<number>();
  const outcomes = new Map<string, { expires: number; result: ExplorerRepairResult; sessionKey: string; connId?: string }>();
  const resolveConversation = (db: DatabaseSync, sessionKey: string) => {
    const row = db.prepare(`SELECT conversation_id AS id FROM conversations WHERE session_key = ?
      AND active = 1 ORDER BY created_at DESC, conversation_id DESC LIMIT 1`).get(sessionKey) as { id: number } | undefined;
    if (!row) throw new Error("This conversation is no longer active. Reopen the panel.");
    return row.id;
  };
  const preflight = async (db: DatabaseSync, id: number) => {
    const doctor = getDoctorSummaryStats(db, id);
    return buildDoctorApplySafetyPreflight({ config: options.config, doctor,
      repairMetrics: doctor.total > 25 ? { repairInputTokenCount: 0, repairTargetSourceTokenCount: 0 }
        : loadDoctorApplyRepairMetrics(db, doctor),
      maintenance: await new CompactionMaintenanceStore(db).getConversationCompactionMaintenance(id) });
  };
  const handler = async (ctx: PluginSessionActionContext) => {
    if (!ctx.sessionKey?.trim()) return { ok: false as const, error: "Select a session first." };
    const sessionKey = ctx.sessionKey;
    const input = ctx.payload ?? {};
    // Host enforces this too. Keep the mutation guarded when called directly.
    if (!ctx.client?.scopes.some(scope => scope === "operator.write" || scope === "operator.admin")) {
      return { ok: false as const, error: "Repair requires write access." };
    }
    try {
      for (const [key, value] of plans) if (value.expires < Date.now()) plans.delete(key);
      for (const [key, value] of outcomes) if (value.expires < Date.now()) outcomes.delete(key);
      const db = await getDb();
      const id = resolveConversation(db, sessionKey);
      if (input.mode === "preview") {
        if (running.has(id)) throw new Error("A repair is already running for this conversation.");
        const plan = await withExclusiveDatabaseLock(db, { timeoutMs: 2000 }, async () => {
          const targets = loadDoctorTargets(db, id);
          const safety = await preflight(db, id);
          return { token: randomUUID(), count: targets.length, requiresOffline: safety.blocked,
            reasons: safety.reasons, sessionKey, connId: ctx.client?.connId, conversationId: id,
            fingerprint: fingerprint(db, targets), summaryIds: targets.map(t => t.summaryId), expires: Date.now() + 300_000 };
        });
        plans.set(plan.token, plan);
        // Avoid retaining unlimited abandoned confirmations.
        if (plans.size > 100) plans.delete(plans.keys().next().value!);
        return { ok: true as const, result: { token: plan.token, count: plan.count,
          requiresOffline: plan.requiresOffline, reasons: plan.reasons } };
      }
      if (input.mode !== "apply" || input.confirm !== true || typeof input.token !== "string") {
        throw new Error("Review and confirm the repair first.");
      }
      const previous = outcomes.get(input.token);
      if (previous && previous.sessionKey === sessionKey && previous.connId === ctx.client?.connId) {
        return { ok: true as const, result: previous.result };
      }
      const plan = plans.get(input.token);
      if (!plan || plan.sessionKey !== sessionKey || plan.connId !== ctx.client?.connId || plan.conversationId !== id) {
        throw new Error("This repair preview expired. Review the repair again.");
      }
      if (running.has(id)) throw new Error("A repair is already running for this conversation.");
      running.add(id);
      try {
        const validate = () => {
          if (resolveConversation(db, sessionKey) !== id || fingerprint(db, loadDoctorTargets(db, id)) !== plan.fingerprint) {
            throw new Error("Summaries changed. Review the repair again.");
          }
        };
        await withExclusiveDatabaseLock(db, { timeoutMs: 2000 }, async () => {
          validate();
          const safety = await preflight(db, id);
          if ((plan.requiresOffline || safety.blocked) && input.confirmOffline !== true) {
            throw new Error("Offline confirmation required. Review the repair again.");
          }
        });
        const result = await applyScopedDoctorRepair({ db, ...options, conversationId: id, sessionKey,
          targetSummaryIds: plan.summaryIds, beforeCommit: validate });
        if (result.kind === "unavailable") throw new Error("Repair is unavailable. Check the Lossless logs and try again.");
        const value = { repaired: result.repaired, unchanged: result.unchanged, skipped: result.skipped.length };
        outcomes.set(plan.token, { expires: Date.now() + 300_000, result: value, sessionKey, connId: ctx.client?.connId });
        plans.delete(plan.token);
        return { ok: true as const, result: value };
      } finally { running.delete(id); }
    } catch (error) {
      // Do not expose database paths, provider details, or credentials to the browser.
      const message = error instanceof Error ? error.message : "";
      const safe = /^(This |A repair |Review and confirm|Summaries changed\.|Offline confirmation required\.|Repair is unavailable\.)/.test(message);
      return { ok: false as const, error: safe ? message : "Could not repair summaries. Check the Lossless logs and try again." };
    }
  };
  api.session?.controls?.registerSessionAction?.({ id: "context-explorer-repair",
    description: "Preview or explicitly confirm repairs for this conversation's flagged summaries.",
    requiredScopes: ["operator.write"],
    schema: { type: "object", additionalProperties: false, required: ["mode"], properties: {
      mode: { enum: ["preview", "apply"] }, token: { type: "string", maxLength: 100 },
      confirm: { type: "boolean" }, confirmOffline: { type: "boolean" },
    } }, handler });
}

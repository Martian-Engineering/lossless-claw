import { GapRepairError } from "../gap-repair-error.js";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { withOnlineRepairOwnership } from "../db/connection.js";
import type { LcmConfig } from "../db/config.js";
import type { LcmDependencies } from "../types.js";
import type { LcmSummarizeFn } from "../summarize.js";
import { sessionMaintenanceGate } from "../session-maintenance.js";
import { withExclusiveDatabaseLock } from "../transaction-mutex.js";
import { digest, planRepair, type RepairPlan } from "../gap-repair.js";
import { discoverGapEvidence, type GapTarget } from "./lcm-gap-source.js";
import { publishGapRecovery } from "./lcm-gap-publish.js";
import { prepareGapRecoveryWorker } from "./lcm-gap-worker.js";

type Preview = { plan: RepairPlan; target: GapTarget; owner: string; expires: number; unresolved: number[] };
export type GapRepairRuntime = { getGapRepairBudget(sessionId: string, sessionKey: string): number | undefined };
export type GapCommandContext = { isAuthorizedSender?: boolean; senderId?: string; sessionKey?: string; sessionId?: string };

/** One controller per registered command. Previews are private, bounded and
 * sender+invoking-session bound. Reload expires them rather than replaying work. */
export class GapRepairController {
  private previews = new Map<string, Preview>();
  constructor(private params: {
    db: () => Promise<DatabaseSync>; config: LcmConfig; deps?: LcmDependencies;
    runtime: () => Promise<GapRepairRuntime | undefined>;
    workerUrl?: URL;
    summarize?: (ctx: GapCommandContext) => Promise<LcmSummarizeFn | undefined>;
  }) {}
  async run(ctx: GapCommandContext, cid: number, confirmation?: string): Promise<string> {
    try {
      if (ctx.isAuthorizedSender !== true || typeof ctx.senderId !== "string" || !ctx.senderId.trim() || typeof ctx.sessionKey !== "string" || !ctx.sessionKey.trim()) throw new GapRepairError("An authorized sender and identifiable invoking session are required.");
      const invokingKey = ctx.sessionKey.trim();
      const db = await this.params.db();
      const row = db.prepare("SELECT session_id,session_key FROM conversations WHERE conversation_id=?").get(cid) as any;
      if (!row?.session_key || !row.session_id) throw new GapRepairError("Target conversation has no usable session binding.");
      const target = { conversationId: cid, sessionId: row.session_id, sessionKey: row.session_key };
      if (invokingKey === target.sessionKey.trim() || ctx.sessionId?.trim() === target.sessionId.trim())
        throw new GapRepairError("Run this command from another session, not the target conversation.");
      const runtime = await this.params.runtime();
      const budget = runtime?.getGapRepairBudget(target.sessionId, target.sessionKey);
      if (!budget || !Number.isSafeInteger(budget) || budget <= 0) throw new GapRepairError("No host-observed target budget is available. Let the target complete a normal turn, then preview again.");
      if (!this.params.deps) throw new GapRepairError("Host history reader unavailable.");
      const owner = digest([ctx.senderId, invokingKey]);
      if (!confirmation) {
        const found = await discoverGapEvidence(db, this.params.deps, target, budget);
        if (!found.evidence.groups.length) return `Conversation ${cid}: no exact recoverable spans. ${found.unresolved.length} unresolved gap(s) retained. No changes made.`;
        const plan = planRepair(db, found.evidence);
        const token = randomBytes(6).toString("hex");
        for (const [id, p] of this.previews) if (p.expires < Date.now()) this.previews.delete(id);
        if (this.previews.size >= 32) this.previews.delete(this.previews.keys().next().value!);
        this.previews.set(token, { plan, target, owner, expires: Date.now() + 600_000, unresolved: found.unresolved });
        return `Conversation ${cid}: recover ${found.evidence.groups.reduce((n,g) => n+g.messages.length,0)} messages across ${found.evidence.groups.length} gaps; ${found.unresolved.length} unresolved gaps remain.\nThe target is locked during recovery after its current turn finishes. Gateway and other sessions stay available. A private backup is automatic. Summary rebuilding may use the configured model and incur cost; raw history and original summaries are retained. Host-observed allowance: ${budget} tokens.\nWithin 10 minutes, from this session: /lossless doctor apply gaps ${cid} ${token}`;
      }
      const preview = this.previews.get(confirmation);
      if (!preview || preview.expires < Date.now() || preview.owner !== owner || preview.target.conversationId !== cid)
        throw new GapRepairError("Preview missing, expired or belongs to another sender/session. Run /lossless doctor gaps <id> again.");
      // One-use even if validation fails: never replay an uncertain job blindly.
      this.previews.delete(confirmation);
      if (budget !== preview.plan.evidence.tokenBudget) throw new GapRepairError("Target allowance changed; preview again.");
      return await sessionMaintenanceGate(db).exclusive(target.sessionKey, () => withOnlineRepairOwnership(db, async () => {
        if (runtime?.getGapRepairBudget(target.sessionId, target.sessionKey) !== budget)
          throw new GapRepairError("Target allowance changed; preview again.");
        const fresh = await discoverGapEvidence(db, this.params.deps!, target, budget);
        if (digest(fresh.evidence) !== digest(preview.plan.evidence)) throw new GapRepairError("Visible source changed; preview again.");
        if (planRepair(db, fresh.evidence).before !== preview.plan.before) throw new GapRepairError("Target changed; preview again.");
        const result = await this.prepareAndPublish(db, preview, ctx);
        return `Conversation ${cid}: recovered ${result.inserted} messages across ${preview.plan.evidence.groups.length} gaps. Repaired context: ${result.tokens}/${budget} tokens. ${preview.unresolved.length} unresolved gaps retained. Original markers and raw history remain; recovery verifies only the exact host-visible spans. Target unlocked. Backup: ${result.backupPath}`;
      }));
    } catch (error) {
      // Internal/provider errors can contain transcript text. Return only known
      // operational messages; never echo arbitrary model/SQLite errors into chat.
      this.params.deps?.log.warn(`[lcm] gap-repair refused conversation=${cid} reason=${error instanceof GapRepairError ? error.message : "internal validation failed (details redacted)"}`);
      return `Gap recovery unavailable: ${error instanceof GapRepairError ? error.message : "Safety validation failed; no recovery was published. Preview again after checking Lossless diagnostics."}`;
    }
  }
  private async prepareAndPublish(db: DatabaseSync, preview: Preview, ctx: GapCommandContext) {
    const config = this.params.config;
    const path = (db.prepare("PRAGMA database_list").all() as any[]).find(r => r.name === "main")?.file;
    if (!path) throw new GapRepairError("Online repair requires a file-backed database.");
    const directory = mkdtempSync(join(dirname(path), "lcm-gap-recovery-")); chmodSync(directory, 0o700);
    const backupPath = join(directory, "before.sqlite"), stagePath = join(directory, "preparation.sqlite");
    writeFileSync(join(directory, "plan.json"), JSON.stringify(preview.plan), { mode: 0o600, flag: "wx" });
    let stage: DatabaseSync | undefined;
    try {
      const prepared = await prepareGapRecoveryWorker({ sourcePath: path, stagePath, backupPath,
        plan: preview.plan, config }, async () => this.params.summarize?.(ctx), this.params.workerUrl);
      const budget = preview.plan.evidence.tokenBudget;
      stage = new DatabaseSync(stagePath, { readOnly: true });
      const fresh = await discoverGapEvidence(db, this.params.deps!, preview.target, budget);
      if (digest(fresh.evidence) !== digest(preview.plan.evidence)) throw new GapRepairError("Visible source changed; preview again.");
      const latestRuntime = await this.params.runtime();
      if (latestRuntime?.getGapRepairBudget(preview.target.sessionId, preview.target.sessionKey) !== budget)
        throw new GapRepairError("Target allowance changed; preview again.");
      const preparedDb = stage;
      const result = await withExclusiveDatabaseLock(db, { timeoutMs: 30_000 }, () => publishGapRecovery(db, preparedDb, preview.plan, backupPath));
      return { ...result, tokens: prepared.tokens, backupPath };
    } finally {
      stage?.close();
      // Only disposable preparation files; the protected backup is retained.
      for (const suffix of ["", "-wal", "-shm", ".maintenance.sqlite"]) {
        try { rmSync(stagePath + suffix, { force: true }); } catch { /* retain private evidence on cleanup failure */ }
      }
    }
  }
}

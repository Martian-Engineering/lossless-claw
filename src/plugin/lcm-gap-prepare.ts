import { backup, DatabaseSync } from "node:sqlite";
import { chmodSync, constants, copyFileSync, statfsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { createLcmDatabaseConnection } from "../db/connection.js";
import { applyRepair, type RepairPlan } from "../gap-repair.js";
import { ContextAssembler } from "../assembler.js";
import { CompactionEngine } from "../compaction.js";
import { ConversationStore } from "../store/conversation-store.js";
import { SummaryStore } from "../store/summary-store.js";
import type { LcmConfig } from "../db/config.js";
import { validateGapCoverage } from "./lcm-gap-publish.js";
import { detectDoctorMarkerForRow } from "./lcm-doctor-shared.js";
import { GapRepairError } from "../gap-repair-error.js";

// Dedicated worker: no host capabilities, credentials, logging, network or tools.
// Provider calls are requested over the private parent port and remain host-owned.
const port = parentPort!;
const input = workerData as { sourcePath: string; stagePath: string; backupPath: string; plan: RepairPlan; config: LcmConfig };
let nextId = 0;
const replies = new Map<number, { resolve: (value: string) => void; reject: (error: Error) => void }>();
port.on("message", (reply: { id: number; text?: string; failed?: boolean }) => {
  const waiter = replies.get(reply.id); if (!waiter) return;
  replies.delete(reply.id);
  if (reply.failed || !reply.text?.trim()) waiter.reject(new GapRepairError("Repair summary rebuilding failed. No recovery was published."));
  else waiter.resolve(reply.text);
});
async function prepare() {
  const { sourcePath, stagePath, backupPath, plan, config } = input;
  const storage = statfsSync(dirname(sourcePath));
  let required = statSync(sourcePath).size;
  try { required += statSync(sourcePath + "-wal").size; } catch { /* no WAL */ }
  if (storage.bavail * storage.bsize < required * 2 + 32 * 1024 * 1024)
    throw new GapRepairError("Repair backup/preparation requires more free local storage. No recovery was published.");
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try { await backup(source, backupPath); } finally { source.close(); }
  chmodSync(backupPath, 0o600);
  const checkpoint = new DatabaseSync(backupPath, { readOnly: true });
  try {
    if (checkpoint.prepare("PRAGMA integrity_check").all().some(r => r.integrity_check !== "ok") || checkpoint.prepare("PRAGMA foreign_key_check").all().length)
      throw new GapRepairError("Repair backup validation failed.");
  } finally { checkpoint.close(); }
  copyFileSync(backupPath, stagePath, constants.COPYFILE_FICLONE);
  const stage = createLcmDatabaseConnection(stagePath, { maintenance: true });
  try {
    const cid = plan.evidence.conversationId, budget = plan.evidence.tokenBudget;
    const originalSummaryIds = new Set((stage.prepare("SELECT summary_id FROM summaries WHERE conversation_id=?").all(cid) as any[]).map(r => r.summary_id));
    // The intermediate frontier may exceed allowance ONLY in this disposable
    // preparation DB. The native full-fit guard is mandatory before publication.
    await applyRepair(stage, plan, Infinity, true);
    const store = new ConversationStore(stage, { fts5Available: true });
    const summaries = new SummaryStore(stage, { fts5Available: true });
    const assemble = () => new ContextAssembler(store, summaries, config.timezone).assemble({ conversationId: cid,
      tokenBudget: budget, freshTailCount: config.freshTailCount, freshTailMaxTokens: config.freshTailMaxTokens });
    let assembled = await assemble();
    if (assembled.debug?.selectionMode !== "full-fit" || assembled.estimatedTokens > budget) {
      const compaction = new CompactionEngine(store, summaries, { ...config, maxRounds: 10 });
      await compaction.compactUntilUnder({ allowCurrentTurnCompaction: true, conversationId: cid,
        tokenBudget: budget, targetTokens: Math.floor(budget * 0.8),
        summarize: (text, aggressive, options) => new Promise<string>((resolve, reject) => {
          const id = ++nextId; replies.set(id, { resolve, reject });
          port.postMessage({ kind: "summarize", id, text, aggressive, options });
        }) });
      assembled = await assemble();
    }
    if (assembled.debug?.selectionMode !== "full-fit" || assembled.estimatedTokens > budget)
      throw new GapRepairError("Repair frontier could not be prepared within the target allowance. No recovery was published.");
    const prepared = validateGapCoverage(stage, cid);
    if (prepared.summaries.some(s => !originalSummaryIds.has(s.summary_id) && detectDoctorMarkerForRow(s as { content: string; model?: string })))
      throw new GapRepairError("Repair summary validation failed. No recovery was published.");
    if (stage.prepare("PRAGMA integrity_check").all().some(r => r.integrity_check !== "ok") || stage.prepare("PRAGMA foreign_key_check").all().length)
      throw new GapRepairError("Repair preparation integrity failed.");
    return { tokens: assembled.estimatedTokens };
  } finally { stage.close(); }
}
prepare().then(result => { port.postMessage({ kind: "ready", ...result }); port.close(); }, error => {
  port.postMessage({ kind: "failed", reason: error instanceof GapRepairError ? error.message : "Repair preparation failed validation. No recovery was published." });
  port.close();
});

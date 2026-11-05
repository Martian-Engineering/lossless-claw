import { Worker } from "node:worker_threads";
import type { RepairPlan } from "../gap-repair.js";
import type { LcmConfig } from "../db/config.js";
import type { LcmSummarizeFn } from "../summarize.js";
import { GapRepairError } from "../gap-repair-error.js";

/** CPU-heavy backup/checks/staging run outside Gateway's event loop. Host-owned
 * model calls remain in the invoking command capability scope. No transcript
 * payload/error is printed or returned to the user. */
export async function prepareGapRecoveryWorker(input: {
  sourcePath: string; backupPath: string; stagePath: string; plan: RepairPlan; config: LcmConfig;
}, summarize: () => Promise<LcmSummarizeFn | undefined>, workerUrl?: URL): Promise<{ tokens: number }> {
  const worker = new Worker(workerUrl ?? new URL("./gap-recovery-worker.js", import.meta.url), { workerData: input, env: {} });
  let done = false;
  try {
    return await new Promise<{ tokens: number }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new GapRepairError("Repair preparation timed out. No recovery was published.")), 300_000);
      const finish = (result?: { tokens: number }, error?: Error) => {
        if (done) return; done = true; clearTimeout(timer);
        if (error) reject(error); else resolve(result!);
      };
      worker.on("error", () => finish(undefined, new GapRepairError("Repair preparation worker failed. No recovery was published.")));
      worker.on("exit", () => { if (!done) finish(undefined, new GapRepairError("Repair preparation worker stopped. No recovery was published.")); });
      worker.on("message", async (message) => {
        if (done) return;
        if (message.kind === "ready") { finish({ tokens: message.tokens }); return; }
        if (message.kind === "failed") { finish(undefined, new GapRepairError(message.reason)); return; }
        if (message.kind !== "summarize") return;
        try {
          const fn = await summarize();
          if (!fn) throw new Error("Summarizer unavailable");
          const text = await fn(message.text, message.aggressive, message.options);
          if (!done) worker.postMessage({ id: message.id, text });
        } catch { if (!done) worker.postMessage({ id: message.id, failed: true }); }
      });
    });
  } finally { done = true; await worker.terminate(); }
}

import { GapRepairError } from "./gap-repair-error.js";
import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";

/** Shared by engines on the same handle. Never use a confirmation as a lock. */
export class SessionMaintenanceGate {
  private lanes = new Map<string, { readers: number; turn: boolean; writer: boolean; pending: boolean; wake: Set<() => void> }>();
  private scope = new AsyncLocalStorage<{ keys: Set<string>; active: boolean }>();
  private lane(key: string) {
    let lane = this.lanes.get(key);
    if (!lane) this.lanes.set(key, lane = { readers: 0, turn: false, writer: false, pending: false, wake: new Set() });
    return lane;
  }
  private signal(key: string) { for (const wake of this.lane(key).wake) wake(); }
  private async wait(key: string, ready: () => boolean, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    while (!ready()) {
      await new Promise<void>((resolve, reject) => {
        const lane = this.lane(key);
        const done = () => { clearTimeout(timer); lane.wake.delete(done); resolve(); };
        const timer = setTimeout(() => { lane.wake.delete(done); reject(new GapRepairError("Target session is busy; no repair ran. Wait for its turn to finish and retry.")); }, Math.max(1, deadline - Date.now()));
        lane.wake.add(done);
      });
    }
  }
  async operation<T>(key: string, operation: () => Promise<T>, phase?: "begin" | "end"): Promise<T> {
    if (this.scope.getStore()?.active && this.scope.getStore()!.keys.has(key)) return operation();
    const lane = this.lane(key);
    // A pending writer must still let the already-admitted turn finish.
    await this.wait(key, () => !lane.writer && (!lane.pending || (lane.turn && phase !== "begin")), 300_000);
    lane.readers++;
    if (phase === "begin") lane.turn = true;
    const scope = { keys: new Set(this.scope.getStore()?.keys ?? []), active: true }; scope.keys.add(key);
    try { return await this.scope.run(scope, operation); }
    catch (error) { if (phase === "begin") lane.turn = false; throw error; }
    finally {
      scope.active = false;
      if (phase === "end") lane.turn = false;
      lane.readers--; this.signal(key);
    }
  }
  async exclusive<T>(key: string, operation: () => Promise<T>, timeoutMs = 30_000): Promise<T> {
    const lane = this.lane(key);
    if ((this.scope.getStore()?.active && this.scope.getStore()!.keys.has(key)) || lane.pending || lane.writer) throw new GapRepairError("Target session already has maintenance running.");
    lane.pending = true;
    try {
      await this.wait(key, () => lane.readers === 0 && !lane.turn, timeoutMs);
      lane.writer = true;
      return await operation();
    } finally { lane.writer = false; lane.pending = false; this.signal(key); }
  }
}
const gates = new WeakMap<DatabaseSync, SessionMaintenanceGate>();
export function sessionMaintenanceGate(db: DatabaseSync): SessionMaintenanceGate {
  let gate = gates.get(db); if (!gate) gates.set(db, gate = new SessionMaintenanceGate()); return gate;
}

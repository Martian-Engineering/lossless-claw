import { GapRepairError } from "./gap-repair-error.js";
import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";

export type MaintenanceRunScope = {
  run<T>(operation: () => T): T;
  dispose(): void;
};

/** Shared by engines on the same handle. Never use a confirmation as a lock. */
export class SessionMaintenanceGate {
  private lanes = new Map<string, { readers: number; turns: Set<object>; unscopedOwner: object; writer: boolean; pending: boolean; wake: Set<() => void> }>();
  private scope = new AsyncLocalStorage<{ keys: Set<string>; active: boolean }>();
  private runScope = new AsyncLocalStorage<{ owner: object; keys: Set<string>; disposed: boolean }>();
  private lane(key: string) {
    let lane = this.lanes.get(key);
    if (!lane) this.lanes.set(key, lane = { readers: 0, turns: new Set(), unscopedOwner: {}, writer: false, pending: false, wake: new Set() });
    return lane;
  }
  /** Each host factory wrapper owns its own terminal cleanup. The shared engine
   * must not clear another session's or a successor run's admission on dispose. */
  createRunScope(): MaintenanceRunScope {
    const state = { owner: {}, keys: new Set<string>(), disposed: false };
    return {
      run: <T>(operation: () => T): T => {
        if (state.disposed) throw new GapRepairError("Context-engine run has already ended.");
        return this.runScope.run(state, operation);
      },
      dispose: () => {
        if (state.disposed) return;
        state.disposed = true;
        for (const key of state.keys) {
          this.lane(key).turns.delete(state.owner);
          this.signal(key);
        }
      },
    };
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
    const run = this.runScope.getStore();
    if (run?.disposed) throw new GapRepairError("Context-engine run has already ended.");
    if (this.scope.getStore()?.active && this.scope.getStore()!.keys.has(key)) return operation();
    const lane = this.lane(key);
    const owner = run?.owner ?? lane.unscopedOwner;
    run?.keys.add(key);
    // A pending writer must still let the already-admitted turn finish.
    await this.wait(key, () => !!run?.disposed || (!lane.writer && (!lane.pending || (lane.turns.has(owner) && phase !== "begin"))), 300_000);
    if (run?.disposed) throw new GapRepairError("Context-engine run has already ended.");
    lane.readers++;
    if (phase === "begin") lane.turns.add(owner);
    const scope = { keys: new Set(this.scope.getStore()?.keys ?? []), active: true }; scope.keys.add(key);
    try { return await this.scope.run(scope, operation); }
    catch (error) { if (phase === "begin") lane.turns.delete(owner); throw error; }
    finally {
      scope.active = false;
      if (phase === "end") lane.turns.delete(owner);
      lane.readers--; this.signal(key);
    }
  }
  async exclusive<T>(key: string, operation: () => Promise<T>, timeoutMs = 30_000): Promise<T> {
    const lane = this.lane(key);
    if ((this.scope.getStore()?.active && this.scope.getStore()!.keys.has(key)) || lane.pending || lane.writer) throw new GapRepairError("Target session already has maintenance running.");
    lane.pending = true;
    try {
      await this.wait(key, () => lane.readers === 0 && lane.turns.size === 0, timeoutMs);
      lane.writer = true;
      return await operation();
    } finally { lane.writer = false; lane.pending = false; this.signal(key); }
  }
}
const gates = new WeakMap<DatabaseSync, SessionMaintenanceGate>();
export function sessionMaintenanceGate(db: DatabaseSync): SessionMaintenanceGate {
  let gate = gates.get(db); if (!gate) gates.set(db, gate = new SessionMaintenanceGate()); return gate;
}

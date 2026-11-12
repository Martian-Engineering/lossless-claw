import { expect, it } from "vitest";
import { SessionMaintenanceGate } from "../src/session-maintenance.js";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

it("settles only the cancelled run and wakes its waiting repair", async () => {
  const gate = new SessionMaintenanceGate();
  const run = gate.createRunScope();
  await run.run(() => gate.operation("target", async () => {}, "begin"));
  let entered = false;
  const repair = gate.exclusive("target", async () => { entered = true; });
  await tick();
  expect(entered).toBe(false);
  run.dispose();
  await repair;
  expect(entered).toBe(true);
  expect(() => run.run(() => Promise.resolve())).toThrow(/already ended/);
});

it("old finalizers and delayed end callbacks cannot settle a successor", async () => {
  const gate = new SessionMaintenanceGate();
  const old = gate.createRunScope(), next = gate.createRunScope();
  await old.run(() => gate.operation("target", async () => {}, "begin"));
  const hold = barrier();
  const delayedEnd = old.run(() => gate.operation("target", () => hold.promise, "end"));
  await tick();
  old.dispose();
  await next.run(() => gate.operation("target", async () => {}, "begin"));
  hold.release(); await delayedEnd;
  old.dispose();
  await expect(gate.exclusive("target", async () => {}, 5)).rejects.toThrow(/busy/);
  next.dispose();
  await gate.exclusive("target", async () => {});
});

it("disposing another session's wrapper does not release the target", async () => {
  const gate = new SessionMaintenanceGate();
  const target = gate.createRunScope(), other = gate.createRunScope();
  await target.run(() => gate.operation("target", async () => {}, "begin"));
  await other.run(() => gate.operation("other", async () => {}, "begin"));
  other.dispose();
  await expect(gate.exclusive("target", async () => {}, 5)).rejects.toThrow(/busy/);
  await gate.exclusive("other", async () => {});
  target.dispose();
  await gate.exclusive("target", async () => {});
});

it("terminal settlement does not bypass an in-flight operation", async () => {
  const gate = new SessionMaintenanceGate();
  const run = gate.createRunScope();
  const hold = barrier();
  const operation = run.run(() => gate.operation("target", () => hold.promise, "begin"));
  await tick();
  run.dispose();
  let entered = false;
  const repair = gate.exclusive("target", async () => { entered = true; });
  await tick(); expect(entered).toBe(false);
  hold.release(); await operation; await repair;
  expect(entered).toBe(true);
});

it("a disposed queued run never enters after the writer releases", async () => {
  const gate = new SessionMaintenanceGate();
  const hold = barrier();
  const writer = gate.exclusive("target", () => hold.promise);
  await tick();
  const run = gate.createRunScope(); let entered = false;
  const queued = run.run(() => gate.operation("target", async () => { entered = true; }, "begin"));
  const refused = expect(queued).rejects.toThrow(/already ended/);
  await tick(); run.dispose();
  await refused;
  hold.release(); await writer;
  expect(entered).toBe(false);
});

it("pending repair admits only the existing owner's completion, not a new run's work", async () => {
  const gate = new SessionMaintenanceGate();
  const current = gate.createRunScope(), next = gate.createRunScope();
  await current.run(() => gate.operation("target", async () => {}, "begin"));
  const hold = barrier(); const events: string[] = [];
  const repair = gate.exclusive("target", async () => { events.push("repair"); await hold.promise; });
  const queued = next.run(() => gate.operation("target", async () => { events.push("next"); }));
  await tick(); expect(events).toEqual([]);
  await current.run(() => gate.operation("target", async () => {}, "end"));
  await tick(); expect(events).toEqual(["repair"]);
  hold.release(); await repair; await queued;
  expect(events).toEqual(["repair", "next"]);
  current.dispose(); next.dispose();
});

import { describe, it, expect, afterEach } from "vitest";
import { createDaemon, type DaemonInstance } from "../../../src/daemon/server.js";
import { loadDaemonConfig } from "../../../src/daemon/config.js";

describe("POST /restore", () => {
  let daemon: DaemonInstance | undefined;
  afterEach(async () => { if (daemon) { await daemon.stop(); daemon = undefined; } });

  it("returns orientation-only for first-ever session", async () => {
    daemon = await createDaemon(loadDaemonConfig("/x", { daemon: { port: 0 } }));
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/restore`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "new-sess", cwd: "/tmp/brand-new-restore-project", hook_event_name: "SessionStart" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.context).toContain("<memory-orientation>");
    expect(body.context).not.toContain("<recent-session-context>");
  });

  it("returns orientation-only for source=compact", async () => {
    daemon = await createDaemon(loadDaemonConfig("/x", { daemon: { port: 0 } }));
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/restore`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "s1", cwd: "/tmp/compact-test", source: "compact", hook_event_name: "SessionStart" }),
    });
    const body = await res.json();
    expect(body.context).toContain("<memory-orientation>");
    expect(body.context).not.toContain("<recent-session-context>");
  });
});

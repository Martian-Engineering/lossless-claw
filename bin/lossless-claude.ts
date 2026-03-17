#!/usr/bin/env node
import { argv, exit, stdin, stdout } from "node:process";

const command = argv[2];

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (stdin.isTTY) { resolve(""); return; }
    const chunks: Buffer[] = [];
    stdin.on("data", (chunk) => chunks.push(chunk));
    stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
  });
}

async function main() {
  switch (command) {
    case "daemon": {
      if (argv[3] === "start") {
        const { createDaemon } = await import("../src/daemon/server.js");
        const { loadDaemonConfig } = await import("../src/daemon/config.js");
        const { join } = await import("node:path");
        const { homedir } = await import("node:os");
        const config = loadDaemonConfig(join(homedir(), ".lossless-claude", "config.json"));
        const daemon = await createDaemon(config);
        console.log(`lossless-claude daemon started on port ${daemon.address().port}`);
        process.on("SIGTERM", () => exit(0));
        process.on("SIGINT", () => exit(0));
      }
      break;
    }
    case "compact": {
      const { handlePreCompact } = await import("../src/hooks/compact.js");
      const { DaemonClient } = await import("../src/daemon/client.js");
      const { loadDaemonConfig } = await import("../src/daemon/config.js");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const config = loadDaemonConfig(join(homedir(), ".lossless-claude", "config.json"));
      const port = config.daemon?.port ?? 3737;
      const input = await readStdin();
      const r = await handlePreCompact(input, new DaemonClient(`http://127.0.0.1:${port}`));
      if (r.stdout) stdout.write(r.stdout);
      exit(r.exitCode);
      break;
    }
    case "restore": {
      const { handleSessionStart } = await import("../src/hooks/restore.js");
      const { DaemonClient } = await import("../src/daemon/client.js");
      const { loadDaemonConfig } = await import("../src/daemon/config.js");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const config = loadDaemonConfig(join(homedir(), ".lossless-claude", "config.json"));
      const port = config.daemon?.port ?? 3737;
      const input = await readStdin();
      const r = await handleSessionStart(input, new DaemonClient(`http://127.0.0.1:${port}`));
      if (r.stdout) stdout.write(r.stdout);
      exit(r.exitCode);
      break;
    }
    case "mcp": {
      const { startMcpServer } = await import("../src/mcp/server.js");
      await startMcpServer();
      break;
    }
    case "install": {
      const { install } = await import("../installer/install.js");
      await install();
      break;
    }
    case "uninstall": {
      const { uninstall } = await import("../installer/uninstall.js");
      await uninstall();
      break;
    }
    default:
      console.error("Usage: lossless-claude <daemon|compact|restore|mcp|install|uninstall>");
      exit(1);
  }
}

main().catch((err) => { console.error(err); exit(1); });

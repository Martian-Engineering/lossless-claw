import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { DaemonConfig } from "./config.js";
import { createCompactHandler } from "./routes/compact.js";
import { createRestoreHandler } from "./routes/restore.js";
import { createGrepHandler } from "./routes/grep.js";
import { createSearchHandler } from "./routes/search.js";
import { createExpandHandler } from "./routes/expand.js";
import { createDescribeHandler } from "./routes/describe.js";
import { createStoreHandler } from "./routes/store.js";
import { createRecentHandler } from "./routes/recent.js";

export type RouteHandler = (req: IncomingMessage, res: ServerResponse, body: string) => Promise<void>;
export type DaemonInstance = { address: () => AddressInfo; stop: () => Promise<void>; registerRoute: (method: string, path: string, handler: RouteHandler) => void };

export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

export async function createDaemon(config: DaemonConfig): Promise<DaemonInstance> {
  const startTime = Date.now();
  const routes = new Map<string, RouteHandler>();

  routes.set("GET /health", async (_req, res) =>
    sendJson(res, 200, { status: "ok", uptime: Math.floor((Date.now() - startTime) / 1000) }));
  routes.set("POST /compact", createCompactHandler(config));
  routes.set("POST /restore", createRestoreHandler(config));
  routes.set("POST /grep", createGrepHandler(config));
  routes.set("POST /search", createSearchHandler(config));
  routes.set("POST /expand", createExpandHandler(config));
  routes.set("POST /describe", createDescribeHandler(config));
  routes.set("POST /store", createStoreHandler(config));
  routes.set("POST /recent", createRecentHandler(config));

  const server: Server = createServer(async (req, res) => {
    const key = `${req.method} ${req.url?.split("?")[0]}`;
    const handler = routes.get(key);
    if (!handler) { sendJson(res, 404, { error: "not found" }); return; }
    try {
      await handler(req, res, req.method !== "GET" ? await readBody(req) : "");
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : "internal error" });
    }
  });

  return new Promise((resolve) => {
    server.listen(config.daemon.port, "127.0.0.1", () => {
      resolve({
        address: () => server.address() as AddressInfo,
        stop: () => new Promise<void>((r) => server.close(() => r())),
        registerRoute: (method, path, handler) => routes.set(`${method} ${path}`, handler),
      });
    });
  });
}

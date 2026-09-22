// Browser contract smoke test. Use a locally installed Playwright, or point
// LCM_PLAYWRIGHT_MODULE at an existing installation's index.mjs.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
const { chromium } = await import(process.env.LCM_PLAYWRIGHT_MODULE || "playwright");
const output = process.env.LCM_UI_ARTIFACT_DIR || "/tmp/lossless-context-explorer-ui";
await mkdir(output, { recursive: true });
const server = createServer(async (req, res) => {
  const filename = req.url === "/index.js" ? "dist/control-ui/index.js" : req.url === "/index.css" ? "dist/control-ui/index.css" : null;
  if (filename) {
    res.setHeader("content-type", filename.endsWith(".css") ? "text/css" : "text/javascript");
    res.end(await readFile(resolve(filename))); return;
  }
  res.setHeader("content-type", "text/html");
  res.end(`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/index.css"><style>
    :root{color-scheme:dark;--text:#dce5e9;--muted:#95a6b0;--card:#1b242b;--border:#303d45}
    body{margin:0;background:#151d24}main{display:flex;flex-direction:column;width:400px;height:800px;min-height:0;margin:auto;border-inline:1px solid #303d45}
    </style></head><body><main id="panel"></main></body></html>`);
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const browser = await chromium.launch({ headless: true, ...(process.env.LCM_BROWSER_PATH ? { executablePath: process.env.LCM_BROWSER_PATH } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 440, height: 960 }, deviceScaleFactor: 2 });
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.clock.install({ time: new Date("2026-09-18T12:00:00Z") });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async () => {
    const plugin = (await import("/index.js")).default;
    const snapshot = {
      basis: "stored-active-context", capturedAt: new Date().toISOString(), conversationId: 1,
      version: "1.0.0", databaseBytes: 750780416, conversationTokens: 276000, compressedTokens: 250000, compressionRatio: 7,
      summaryCount: 3, messageCount: 24, summaryTokens: 12420, messageTokens: 26000, nextOffset: null,
      summaries: [
        { summaryId: "sum_a83d2b", ordinal: 0, kind: "condensed", depth: 2, tokenCount: 6840,
          preview: "Context architecture & design decisions", earliestAt: "2026-09-14", latestAt: "2026-09-14T12:00:00Z", createdAt: "2026-09-16", descendantCount: 18, sourceMessageTokenCount: 186000 },
        { summaryId: "sum_c91e5f", ordinal: 1, quality: "new", kind: "condensed", depth: 1, tokenCount: 3920,
          preview: "Search semantics and session boundaries", earliestAt: "2026-09-16", latestAt: "2026-09-17T12:00:00Z", createdAt: "2026-09-17", descendantCount: 6, sourceMessageTokenCount: 52000 },
        { summaryId: "sum_f24a8c", ordinal: 2, kind: "leaf", depth: 0, tokenCount: 1660,
          preview: "A read-only explorer beside the conversation", earliestAt: "2026-09-18", latestAt: "2026-09-18T07:00:00Z", createdAt: "2026-09-18", descendantCount: 0, sourceMessageTokenCount: 12000 },
      ],
    };
    window.summaryText = "## Design discussion\n" + "Keep the explorer **session-scoped** and preserve summary coverage. ".repeat(12) + "\n\n## Search decision\n" + ("- Preserve the summary DAG\n- Support read-only child inspection\n\n").repeat(15) + "<img src=x onerror=window.injected=true>\n\n[Unsafe](javascript:alert(1))";
    window.snapshot = snapshot; window.calls = []; window.fail = false; window.delay = false;
    const controller = new AbortController();
    const host = { connection: { connected: true }, ui: { registerPanel(panel) { window.panelDefinition = panel; return () => {}; } },
      async request(method, params) {
        window.calls.push({ method, ...params });
        if (window.fail) throw new Error("Network unavailable");
        if (window.delay) await new Promise(done => { window.release = done; });
        if (params.sessionKey === "agent:other:empty") return { ok: true, result: { ...snapshot, conversationId: null, summaryCount: 0, summaries: [] } };
        if (params.actionId === "context-explorer-repair") {
          if (params.payload.mode === "preview") return { ok: true, result: {
            token: "reviewed-token", count: 2, requiresOffline: window.offlineRequired ?? true,
            reasons: ["compaction maintenance is pending"] } };
          window.repairs = (window.repairs ?? 0) + 1;
          return { ok: true, result: { repaired: 2, unchanged: 0, skipped: 0 } };
        }
        if (params.payload.check) return { ok: true, result: { checkedAt: new Date().toISOString(), total: 2, fallback: 0, truncated: 1, emergency: 1,
          summaries: [snapshot.summaries[1]], revealIds: ["sum_a83d2b", "sum_child", "sum_grandchild", snapshot.summaries[1].summaryId], nextOffset: null } };
        if (params.payload.summaryId) return { ok: true, result: { summaryId: params.payload.summaryId,
          content: params.payload.offset ? "\n\n## Final page\nLast paragraph." : window.summaryText,
          nextOffset: params.payload.offset ? null : 24000, sourceMessages: 12,
          children: params.payload.summaryId === "sum_a83d2b" ? [{ summaryId: "sum_child", kind: "condensed", depth: 1, preview: "Choosing a read-only, session-scoped design", tokenCount: 920, createdAt: "2026-09-17", descendantCount: 1, sourceMessageTokenCount: 10000 }] :
            params.payload.summaryId === "sum_child" ? [{ summaryId: "sum_grandchild", quality: "emergency", kind: "leaf", depth: 0, preview: "Sidebar layout and safe Markdown rendering", tokenCount: 420, createdAt: "2026-09-17", descendantCount: 0, sourceMessageTokenCount: 5000 }] : [], childrenTruncated: false } };
        return { ok: true, result: snapshot };
      },
    };
    plugin.activate(host);
    window.ctx = { props: { sessionKey: "agent:main:example", agentId: "main" }, host, signal: controller.signal, presented: true };
    window.view = window.panelDefinition.mount(document.querySelector("#panel"), window.ctx);
    window.controller = controller;
  });
  await page.waitForSelector(".lcm-explorer__card");
  assert.equal(await page.locator(".lcm-explorer__list > .lcm-explorer__card").count(), 3);
  assert.equal(await page.locator(".lcm-explorer__stats strong").first().textContent(), "3");
  assert.equal(await page.getByRole("button", { name: "Refresh", exact: true }).count(), 0);
  assert.deepEqual(await page.locator(".lcm-explorer__age").allTextContents(), ["4d", "1d", "5h"]);
  assert((await page.locator(".lcm-explorer__list > .lcm-explorer__card").first().boundingBox()).height < 60);
  await page.locator(".lcm-explorer").screenshot({ path: resolve(output, "context-explorer.png") });
  await page.locator(".lcm-explorer__card > summary").first().click();
  await page.waitForSelector(".lcm-explorer__content");
  assert.match(await page.locator(".lcm-explorer__content").first().textContent(), /Design discussion/);
  assert.equal(await page.locator(".lcm-explorer img").count(), 0);
  assert.equal(await page.evaluate(() => window.injected), undefined);
  await page.locator(".lcm-explorer__branch > summary").click();
  await page.waitForFunction(() => document.querySelectorAll(".lcm-explorer__content").length === 2);
  await page.screenshot({ path: resolve(output, "context-explorer-expanded.png"), fullPage: true });
  // Every node starts with a rendered, bounded preview; descendants remain reachable.
  const preview = page.locator(".lcm-explorer__preview").first();
  await page.waitForFunction(() => document.querySelector(".lcm-explorer__preview").style.maxHeight !== "");
  const size = await preview.evaluate(node => ({ height: node.clientHeight, full: node.scrollHeight,
    paragraph: node.querySelector("p").getBoundingClientRect().bottom - node.getBoundingClientRect().top }));
  assert(size.height < size.full, "long summary is collapsed");
  assert(size.height >= size.paragraph - 1, "preview preserves the entire first paragraph");
  assert.equal(await page.locator(".lcm-explorer__content h2").first().textContent(), "Design discussion");
  assert.equal(await page.locator(".lcm-explorer__content strong").first().textContent(), "session-scoped");
  assert.equal(await page.locator('a[href^="javascript:"]').count(), 0);
  await page.locator(".lcm-explorer__branch .lcm-explorer__branch > summary").click();
  await page.waitForFunction(() => document.querySelectorAll(".lcm-explorer__content").length === 3);
  const indents = await page.locator(".lcm-explorer__content").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().left));
  assert(indents[0] < indents[1] && indents[1] < indents[2], "descendants are recursively indented");
  const root = page.locator(".lcm-explorer");
  assert(await root.evaluate(node => node.scrollHeight > node.clientHeight), "panel has scrollable overflow");
  await root.evaluate(node => { node.scrollTop = 200; });
  assert(await root.evaluate(node => node.scrollTop > 0), "panel actually scrolls");
  assert.equal(await page.evaluate(() => window.calls.filter(call => call.payload.offset === 24000).length), 0, "full text pages remain lazy");
  await page.getByRole("button", { name: "Show full summary", exact: true }).first().click();
  await page.waitForFunction(() => document.querySelector(".lcm-explorer__content").textContent.includes("Final page"));
  assert.equal(await preview.evaluate(node => node.style.maxHeight), "none");
  await page.getByRole("button", { name: "Show less", exact: true }).click();
  assert.notEqual(await preview.evaluate(node => node.style.maxHeight), "none");
  // Changing the live theme keeps the tree and reading state intact.
  await page.evaluate(() => document.documentElement.style.setProperty("--accent", "rgb(102, 51, 153)"));
  assert.equal(await page.locator(".lcm-explorer__kind").first().evaluate(node => getComputedStyle(node).color), "rgb(102, 51, 153)");
  await page.screenshot({ path: resolve(output, "context-explorer-recursive.png"), fullPage: true });
  assert.equal(await page.locator(".lcm-explorer__total strong").textContent(), "276.0k");
  assert.equal(await page.locator(".lcm-explorer__compression").textContent(), "1:7 compression");
  assert.equal(await page.locator(".lcm-explorer__sources").count(), 1, "only leaves show message counts");
  assert.equal(await page.locator(".lcm-explorer__sources").textContent(), "From 12 messages");
  assert(!(await root.textContent()).includes("sum_"), "no summary IDs in visible copy");
  assert((await page.locator(".lcm-explorer__branch > summary").first().textContent()).includes("Choosing a read-only"));
  await root.evaluate(node => { node.scrollTop = 0; });
  await page.screenshot({ path: resolve(output, "context-explorer-polished.png"), fullPage: true });
  assert.match(await page.locator('.lcm-explorer__list > .lcm-explorer__card').nth(1).locator('.lcm-explorer__warning-badge').textContent(), /Shortened summary/);
  assert.match(await page.locator('[data-summary-id="sum_grandchild"] > summary .lcm-explorer__warning-badge').textContent(), /Emergency summary/);
  assert.match(await page.locator('[data-summary-id="sum_grandchild"] > .lcm-explorer__body > .lcm-explorer__warning').textContent(), /may omit detail/);
  await page.getByRole("button", { name: "Check summaries", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.lcm-explorer__health-report').textContent.includes('2 to repair'));
  assert.equal(await page.evaluate(() => window.calls.filter(call => call.payload.check === true).length), 1);
  assert.equal(await page.getByRole("button", { name: "Check summaries", exact: true }).getAttribute("title"), null);
  assert.match(await page.locator('.lcm-explorer__tail').textContent(), /Lossless v1.0.0 · 716.0 MB/);
  assert.equal(await page.locator('[data-summary-id="sum_grandchild"]').evaluate(node => node.open), true);
  await page.getByRole("button", { name: "Repair…", exact: true }).click();
  await page.getByRole("heading", { name: "Repair 2 summaries?" }).waitFor();
  assert(await page.getByRole("button", { name: "Repair", exact: true }).isDisabled());
  await page.screenshot({ path: resolve(output, "context-explorer-repair-offline.png"), fullPage: true });
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await page.evaluate(() => window.repairs ?? 0), 0, "cancel never repairs");
  await page.evaluate(() => { window.offlineRequired = false; });
  await page.getByRole("button", { name: "Repair…", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.lcm-explorer__primary').disabled);
  assert(await page.locator('.lcm-explorer__offline').isHidden());
  await page.keyboard.press("Escape");
  assert.equal(await page.evaluate(() => window.repairs ?? 0), 0, "Escape never repairs");
  await page.evaluate(() => { window.fail = true; });
  await page.getByRole("button", { name: "Check summaries", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.lcm-explorer__health-report').textContent.includes('Try again'));
  await page.evaluate(() => { window.fail = false; });
  const calls = await page.evaluate(() => window.calls);
  assert(calls.every(call => call.method === "plugins.sessionAction" && call.agentId === "main" && call.sessionKey === "agent:main:example"));
  await page.clock.fastForward(3600000);
  await page.waitForFunction(() => document.querySelectorAll(".lcm-explorer__list > .lcm-explorer__card > summary .lcm-explorer__age")[2].textContent === "6h");
  await page.evaluate(() => { window.snapshot.messageCount++; });
  await page.clock.runFor(10000);
  await page.waitForFunction(() => document.querySelector(".lcm-explorer__stats").textContent.includes("25 recent"));
  assert.equal(await page.locator(".lcm-explorer__list > .lcm-explorer__card[open]").count(), 2);
  assert.equal(await page.locator(".lcm-explorer__content").count(), 4, "polling preserves expanded details");
  await page.evaluate(() => { window.fail = true; });
  await page.clock.runFor(10000);
  await page.waitForFunction(() => document.querySelector('[role="status"]').textContent.includes("retrying"));
  assert.equal(await page.locator(".lcm-explorer__list > .lcm-explorer__card").count(), 3);
  await page.evaluate(() => { window.fail = false; });
  await page.clock.runFor(10000);
  await page.waitForFunction(() => document.querySelector('[role="status"]').textContent === "");
  await page.getByRole("button", { name: "Check summaries", exact: true }).click();
  await page.getByRole("button", { name: "Repair…", exact: true }).waitFor();
  await page.evaluate(() => { window.offlineRequired = true; });
  await page.getByRole("button", { name: "Repair…", exact: true }).click();
  await page.getByRole("heading", { name: "Repair 2 summaries?" }).waitFor();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Repair", exact: true }).click();
  await page.getByRole("heading", { name: "Repair complete" }).waitFor();
  assert.equal(await page.evaluate(() => window.repairs), 1);
  assert.equal(await page.evaluate(() => window.calls.find(call => call.payload.mode === "apply").payload.confirmOffline), true);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.evaluate(() => { window.view.update({ ...window.ctx, presented: false }); });
  const pausedCalls = await page.evaluate(() => window.calls.length);
  await page.clock.runFor(20000);
  assert.equal(await page.evaluate(() => window.calls.length), pausedCalls, "hidden panels do not poll");
  await page.evaluate(() => { window.delay = true; window.view.update(window.ctx); });
  await page.waitForFunction(() => typeof window.release === "function");
  await page.evaluate(() => {
    window.view.update({ ...window.ctx, props: { sessionKey: "agent:other:empty", agentId: "other" } });
    window.delay = false; window.release();
  });
  await page.waitForFunction(() => document.querySelector('[role="status"]').textContent.includes("not recorded"));
  assert.equal(await page.locator(".lcm-explorer__list > .lcm-explorer__card").count(), 0, "old session's response must not repaint the new session");
  assert.equal(await page.locator(".lcm-explorer__health-report").textContent(), "", "session switch clears diagnostics");
  assert.equal((await page.evaluate(() => window.calls)).at(-1).agentId, "other");
  await page.evaluate(() => window.controller.abort());
  assert.equal(await page.locator(".lcm-explorer").count(), 0);
  const disposedCalls = await page.evaluate(() => window.calls.length);
  await page.clock.runFor(20000);
  assert.equal(await page.evaluate(() => window.calls.length), disposedCalls, "disposal stops polling");
  assert.deepEqual(errors, []);
  console.log(`PASS: scrolling, Markdown, bounded previews, full-text paging, recursive descendants, live theme, compact layout, relative ages, automatic refresh/recovery, retained expansion, hidden-panel pause, text safety, session switching, disposal. Screenshots: ${output}`);
} finally { await browser.close(); await new Promise(done => server.close(done)); }

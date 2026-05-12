#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  callTool,
  importCodexArtifacts,
  openSidecarDatabase,
  resolveLogsDbPath,
  resolveSidecarDatabasePath,
  resolveSourceDir,
  resolveStateDbPath,
} from "./mcp-server.mjs";

function parseArgs(argv) {
  const out = { json: false, writeLcmEnrichment: false, query: "codex" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      out.json = true;
    } else if (arg === "--write-lcm-enrichment") {
      out.writeLcmEnrichment = true;
    } else if (arg.startsWith("--")) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      out[key] = value;
      index += 1;
    }
  }
  return out;
}

function summarizeTool(result) {
  const structured = result.structuredContent ?? {};
  return {
    ok: true,
    tool: structured.tool,
    count:
      typeof structured.count === "number"
        ? structured.count
        : typeof structured.counts === "object"
          ? undefined
          : undefined,
    coverage: structured.coverage,
    note: structured.note,
    lcmEnrichment: structured.lcmEnrichment,
  };
}

function getIntegrity(dbPath) {
  const db = openSidecarDatabase(dbPath, { readOnly: true });
  try {
    const scalar = (sql) => db.prepare(sql).get().count;
    return {
      projects: scalar("SELECT COUNT(*) AS count FROM codex_projects"),
      threads: scalar("SELECT COUNT(*) AS count FROM codex_threads"),
      events: scalar("SELECT COUNT(*) AS count FROM codex_events"),
      toolCalls: scalar("SELECT COUNT(*) AS count FROM codex_tool_calls"),
      touchedFiles: scalar("SELECT COUNT(*) AS count FROM codex_touched_files"),
      observations: scalar("SELECT COUNT(*) AS count FROM codex_observations"),
      summaries: scalar("SELECT COUNT(*) AS count FROM codex_summaries"),
      rollups: scalar("SELECT COUNT(*) AS count FROM codex_project_day_rollups"),
      rawPatchInputRows: scalar(
        "SELECT COUNT(*) AS count FROM codex_events WHERE raw_payload_json LIKE '%redacted patch%' OR raw_payload_json LIKE '%unified_diff%'",
      ),
      rawToolOutputRows: scalar(
        "SELECT COUNT(*) AS count FROM codex_events WHERE raw_payload_json LIKE '%stdout%' OR raw_payload_json LIKE '%stderr%'",
      ),
    };
  } finally {
    db.close();
  }
}

function getFirstThreadAndRollup(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec("PRAGMA query_only = ON");
    const thread = db
      .prepare("SELECT thread_id FROM codex_threads ORDER BY updated_at DESC, thread_id ASC LIMIT 1")
      .get();
    const rollup = db
      .prepare(
        `SELECT project_key, period_key
         FROM codex_project_day_rollups
         ORDER BY period_key DESC, project_key ASC
         LIMIT 1`,
      )
      .get();
    return { thread, rollup };
  } finally {
    db.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceDir = resolve(args.sourceDir ?? resolveSourceDir(process.env));
  const stateDbPath = resolve(args.stateDb ?? args.stateDbPath ?? resolveStateDbPath(process.env));
  const logsDbPath = resolve(args.logsDb ?? args.logsDbPath ?? resolveLogsDbPath({ ...process.env, LOSSLESS_CODEX_SOURCE_DIR: sourceDir }));
  const dbPath = resolve(args.sidecarDb ?? args.dbPath ?? resolveSidecarDatabasePath(process.env));
  const lcmDbPath = args.lcmDb ? resolve(args.lcmDb) : undefined;

  if (!existsSync(stateDbPath)) {
    throw new Error(`state DB not found: ${stateDbPath}`);
  }

  const firstImport = await importCodexArtifacts({
    dbPath,
    sourceDir,
    stateDbPath,
    logsDbPath,
    allowWrite: true,
  });
  const secondImport = await importCodexArtifacts({
    dbPath,
    sourceDir,
    stateDbPath,
    logsDbPath,
    allowWrite: true,
  });

  const { thread, rollup } = getFirstThreadAndRollup(dbPath);
  const toolOptions = { dbPath, sourceDir, stateDbPath, lcmDbPath, env: process.env };
  const tools = {};
  tools.lossless_codex_status = summarizeTool(
    await callTool("lossless_codex_status", {}, toolOptions),
  );
  tools.lossless_codex_search = summarizeTool(
    await callTool("lossless_codex_search", { query: args.query, limit: 10 }, toolOptions),
  );
  tools.lossless_codex_recent = summarizeTool(
    await callTool("lossless_codex_recent", rollup ? { period: rollup.period_key } : {}, toolOptions),
  );
  tools.lossless_codex_describe = thread
    ? summarizeTool(
        await callTool(
          "lossless_codex_describe",
          { id: `lossless-codex://thread/${thread.thread_id}` },
          toolOptions,
        ),
      )
    : { ok: false, reason: "no thread imported" };
  tools.lossless_codex_worklog = rollup
    ? summarizeTool(
        await callTool(
          "lossless_codex_worklog",
          {
            projectKey: rollup.project_key,
            period: rollup.period_key,
            writeLcmEnrichment: args.writeLcmEnrichment,
            lcmDbPath,
          },
          {
            ...toolOptions,
            env: {
              ...process.env,
              LOSSLESS_CODEX_LCM_ENRICHMENT_ENABLED: args.writeLcmEnrichment ? "true" : "false",
            },
          },
        ),
      )
    : { ok: false, reason: "no rollup imported" };

  const payload = {
    sourceDir,
    stateDbPath,
    logsDbPath,
    databasePath: dbPath,
    lcmDbPath,
    imports: [firstImport, secondImport],
    tools,
    integrity: getIntegrity(dbPath),
  };

  if (args.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(`Lossless Codex rehearsal\n${JSON.stringify(payload, null, 2)}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});

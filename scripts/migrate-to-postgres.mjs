#!/usr/bin/env node

/**
 * LCM Migration Script — SQLite + JSONL Session History → PostgreSQL
 * 
 * Phase 1: Migrate existing SQLite LCM data (conversations, messages, summaries, etc.)
 * Phase 2: Import historical JSONL session transcripts as conversations
 * 
 * Usage: node migrate-to-postgres.mjs [--sqlite-only] [--jsonl-only] [--dry-run]
 */

import Database from 'better-sqlite3';
import pg from 'pg';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { delimiter, join } from 'path';
import { homedir } from 'os';

const { Pool } = pg;

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SQLITE_ONLY = args.includes('--sqlite-only');
const JSONL_ONLY = args.includes('--jsonl-only');

function readFlagValue(flagName) {
  const prefix = `${flagName}=`;
  const match = args.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length).trim() : undefined;
}

function readFlagValues(flagName) {
  const prefix = `${flagName}=`;
  return args
    .filter((arg) => arg.startsWith(prefix))
    .map((arg) => arg.slice(prefix.length).trim())
    .filter(Boolean);
}

function dedupe(items) {
  return [...new Set(items.filter(Boolean))];
}

function resolveMigrationConfig() {
  const sqlitePath = readFlagValue('--sqlite-path')
    || process.env.LCM_SQLITE_PATH?.trim()
    || join(homedir(), '.openclaw', 'lcm.db');
  const connectionString = readFlagValue('--pg-connection')
    || process.env.LCM_CONNECTION_STRING?.trim()
    || process.env.PG_CONNECTION_STRING?.trim()
    || '';
  const defaultAgentsDir = join(homedir(), '.openclaw', 'agents');
  const extraAgentDirs = [
    ...readFlagValues('--agents-dir'),
    ...(process.env.LCM_AGENT_DIRS ?? '')
      .split(delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean),
  ];

  return {
    sqlitePath,
    connectionString,
    agentDirs: dedupe([defaultAgentsDir, ...extraAgentDirs]),
  };
}

const MIGRATION_CONFIG = resolveMigrationConfig();

// ── Helpers ───────────────────────────────────────────────────────

function log(msg) { console.log(`[migrate] ${msg}`); }
function warn(msg) { console.warn(`[migrate] ⚠️  ${msg}`); }
function ok(msg) { console.log(`[migrate] ✅ ${msg}`); }

// ── Phase 1: SQLite → Postgres ───────────────────────────────────

async function migrateSqlite(pool) {
  if (!existsSync(MIGRATION_CONFIG.sqlitePath)) {
    warn('No SQLite database found, skipping Phase 1');
    return;
  }

  const db = new Database(MIGRATION_CONFIG.sqlitePath, { readonly: true });
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Check if already migrated
    const existing = await client.query('SELECT COUNT(*) as c FROM conversations');
    if (parseInt(existing.rows[0].c) > 0) {
      warn(`Postgres already has ${existing.rows[0].c} conversations. Skipping SQLite migration to avoid duplicates.`);
      await client.query('ROLLBACK');
      return;
    }

    // 1. Conversations
    const convos = db.prepare('SELECT * FROM conversations ORDER BY conversation_id').all();
    log(`Migrating ${convos.length} conversations...`);
    for (const c of convos) {
      if (DRY_RUN) continue;
      await client.query(
        `INSERT INTO conversations (conversation_id, session_id, title, bootstrapped_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [c.conversation_id, c.session_id, c.title, c.bootstrapped_at, c.created_at, c.updated_at]
      );
    }
    // Reset sequence
    if (!DRY_RUN && convos.length > 0) {
      const maxId = Math.max(...convos.map(c => c.conversation_id));
      await client.query(`SELECT setval('conversations_conversation_id_seq', $1)`, [maxId]);
    }

    // 2. Messages
    const msgs = db.prepare('SELECT * FROM messages ORDER BY message_id').all();
    log(`Migrating ${msgs.length} messages...`);
    for (const m of msgs) {
      if (DRY_RUN) continue;
      await client.query(
        `INSERT INTO messages (message_id, conversation_id, seq, role, content, token_count, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [m.message_id, m.conversation_id, m.seq, m.role, m.content, m.token_count, m.created_at]
      );
    }
    if (!DRY_RUN && msgs.length > 0) {
      const maxId = Math.max(...msgs.map(m => m.message_id));
      await client.query(`SELECT setval('messages_message_id_seq', $1)`, [maxId]);
    }

    // 3. Summaries
    const sums = db.prepare('SELECT * FROM summaries ORDER BY created_at').all();
    log(`Migrating ${sums.length} summaries...`);
    for (const s of sums) {
      if (DRY_RUN) continue;
      await client.query(
        `INSERT INTO summaries (summary_id, conversation_id, kind, depth, content, token_count,
         earliest_at, latest_at, descendant_count, descendant_token_count, source_message_token_count,
         file_ids, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [s.summary_id, s.conversation_id, s.kind, s.depth, s.content, s.token_count,
         s.earliest_at, s.latest_at, s.descendant_count, s.descendant_token_count,
         s.source_message_token_count, s.file_ids || '[]', s.created_at]
      );
    }

    // 4. Message parts
    const parts = db.prepare('SELECT * FROM message_parts ORDER BY message_id, ordinal').all();
    log(`Migrating ${parts.length} message parts...`);
    for (const p of parts) {
      if (DRY_RUN) continue;
      await client.query(
        `INSERT INTO message_parts (part_id, message_id, session_id, part_type, ordinal,
         text_content, is_ignored, is_synthetic, tool_call_id, tool_name, tool_status,
         tool_input, tool_output, tool_error, tool_title, patch_hash, patch_files,
         file_mime, file_name, file_url, subtask_prompt, subtask_desc, subtask_agent,
         step_reason, step_cost, step_tokens_in, step_tokens_out, snapshot_hash,
         compaction_auto, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30::jsonb)`,
        [p.part_id, p.message_id, p.session_id, p.part_type, p.ordinal,
         p.text_content, p.is_ignored ? true : null, p.is_synthetic ? true : null,
         p.tool_call_id, p.tool_name, p.tool_status,
         p.tool_input, p.tool_output, p.tool_error, p.tool_title,
         p.patch_hash, p.patch_files, p.file_mime, p.file_name, p.file_url,
         p.subtask_prompt, p.subtask_desc, p.subtask_agent,
         p.step_reason, p.step_cost, p.step_tokens_in, p.step_tokens_out,
         p.snapshot_hash, p.compaction_auto ? true : null,
         p.metadata || null]
      );
    }

    // 5. Summary messages
    const sumMsgs = db.prepare('SELECT * FROM summary_messages').all();
    log(`Migrating ${sumMsgs.length} summary-message links...`);
    for (const sm of sumMsgs) {
      if (DRY_RUN) continue;
      await client.query(
        `INSERT INTO summary_messages (summary_id, message_id, ordinal) VALUES ($1, $2, $3)`,
        [sm.summary_id, sm.message_id, sm.ordinal]
      );
    }

    // 6. Summary parents
    const sumParents = db.prepare('SELECT * FROM summary_parents').all();
    log(`Migrating ${sumParents.length} summary parent links...`);
    for (const sp of sumParents) {
      if (DRY_RUN) continue;
      await client.query(
        `INSERT INTO summary_parents (summary_id, parent_summary_id, ordinal) VALUES ($1, $2, $3)`,
        [sp.summary_id, sp.parent_summary_id, sp.ordinal]
      );
    }

    // 7. Context items
    const ctxItems = db.prepare('SELECT * FROM context_items ORDER BY conversation_id, ordinal').all();
    log(`Migrating ${ctxItems.length} context items...`);
    for (const ci of ctxItems) {
      if (DRY_RUN) continue;
      await client.query(
        `INSERT INTO context_items (conversation_id, ordinal, item_type, message_id, summary_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [ci.conversation_id, ci.ordinal, ci.item_type, ci.message_id, ci.summary_id, ci.created_at]
      );
    }

    // 8. Large files
    const files = db.prepare('SELECT * FROM large_files').all();
    log(`Migrating ${files.length} large files...`);
    for (const f of files) {
      if (DRY_RUN) continue;
      await client.query(
        `INSERT INTO large_files (file_id, conversation_id, file_name, mime_type, byte_size, storage_uri, exploration_summary, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [f.file_id, f.conversation_id, f.file_name, f.mime_type, f.byte_size, f.storage_uri, f.exploration_summary, f.created_at]
      );
    }

    // tsvector columns are GENERATED ALWAYS — no manual update needed

    await client.query('COMMIT');
    ok(`Phase 1 complete: ${convos.length} convos, ${msgs.length} msgs, ${sums.length} summaries, ${parts.length} parts`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    db.close();
  }
}

// ── Phase 2: JSONL Session Transcripts → Postgres ────────────────

function findAllJsonlFiles() {
  const files = [];
  const seen = new Set();

  function scanDir(dir) {
    if (!existsSync(dir)) return;
    const agents = readdirSync(dir, { withFileTypes: true });
    for (const agent of agents) {
      if (!agent.isDirectory()) continue;
      const sessionsDir = join(dir, agent.name, 'sessions');
      if (!existsSync(sessionsDir)) continue;
      const sessionFiles = readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));
      for (const sf of sessionFiles) {
        const fullPath = join(sessionsDir, sf);
        const sessionId = sf.replace('.jsonl', '');
        if (seen.has(sessionId)) continue; // Dedup (backup vs active)
        seen.add(sessionId);
        files.push({
          path: fullPath,
          agentName: agent.name,
          sessionId,
        });
      }
    }
  }

  for (const dir of MIGRATION_CONFIG.agentDirs) {
    scanDir(dir);
  }
  return files;
}

function parseJsonlMessages(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  const messages = [];
  let sessionMeta = null;

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'session') {
        sessionMeta = obj;
      } else if (obj.type === 'message' && obj.message) {
        const msg = obj.message;
        // Extract text content
        let textContent = '';
        if (typeof msg.content === 'string') {
          textContent = msg.content;
        } else if (Array.isArray(msg.content)) {
          textContent = msg.content
            .filter(c => c.type === 'text')
            .map(c => c.text)
            .join('\n');
        }

        // Sanitize invalid UTF-8 sequences
        textContent = textContent.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
        // Replace broken multi-byte sequences
        textContent = Buffer.from(textContent, 'utf-8').toString('utf-8');
        
        if (!textContent.trim()) continue; // Skip empty messages

        // Map non-standard roles to valid ones
        let role = msg.role || 'user';
        const roleMap = { toolResult: 'tool', developer: 'system', function: 'tool' };
        role = roleMap[role] || role;
        if (!['system', 'user', 'assistant', 'tool'].includes(role)) {
          role = 'user'; // Fallback for unknown roles
        }

        messages.push({
          role,
          content: textContent,
          timestamp: obj.timestamp,
          tokenCount: msg.usage?.totalTokens || Math.ceil(textContent.length / 4), // Rough estimate
        });
      }
    } catch (e) {
      // Skip malformed lines
    }
  }

  return { sessionMeta, messages };
}

async function importJsonlSessions(pool) {
  const jsonlFiles = findAllJsonlFiles();
  log(`Found ${jsonlFiles.length} JSONL session files`);

  const client = await pool.connect();
  let imported = 0;
  let skipped = 0;
  let totalMessages = 0;

  try {
    // Get existing session IDs to avoid reimporting
    const existingResult = await client.query('SELECT session_id FROM conversations');
    const existingSessionIds = new Set(existingResult.rows.map(r => r.session_id));

    for (const file of jsonlFiles) {
      if (existingSessionIds.has(file.sessionId)) {
        skipped++;
        continue;
      }

      const { sessionMeta, messages } = parseJsonlMessages(file.path);
      if (messages.length === 0) {
        skipped++;
        continue;
      }

      if (DRY_RUN) {
        log(`  [dry-run] Would import ${file.agentName}/${file.sessionId}: ${messages.length} messages`);
        totalMessages += messages.length;
        imported++;
        continue;
      }

      await client.query('BEGIN');
      try {
        const title = `${file.agentName} session (imported)`;
        const createdAt = sessionMeta?.timestamp || messages[0]?.timestamp || new Date().toISOString();

        // Create conversation
        const convResult = await client.query(
          `INSERT INTO conversations (session_id, title, created_at, updated_at)
           VALUES ($1, $2, $3, $3) RETURNING conversation_id`,
          [file.sessionId, title, createdAt]
        );
        const conversationId = convResult.rows[0].conversation_id;

        // Insert messages
        for (let i = 0; i < messages.length; i++) {
          const m = messages[i];
          await client.query(
            `INSERT INTO messages (conversation_id, seq, role, content, token_count, created_at)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [conversationId, i + 1, m.role, m.content, m.tokenCount, m.timestamp || createdAt]
          );
        }

        await client.query('COMMIT');
        imported++;
        totalMessages += messages.length;
        log(`  ✅ ${file.agentName}/${file.sessionId}: ${messages.length} messages`);
      } catch (err) {
        await client.query('ROLLBACK');
        warn(`  Failed ${file.agentName}/${file.sessionId}: ${err.message}`);
      }
    }

    ok(`Phase 2 complete: ${imported} sessions imported (${totalMessages} messages), ${skipped} skipped`);
  } finally {
    client.release();
  }
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  if (!MIGRATION_CONFIG.connectionString) {
    throw new Error(
      'Missing PostgreSQL connection string. Set LCM_CONNECTION_STRING/PG_CONNECTION_STRING or pass --pg-connection=<dsn>.',
    );
  }

  log(`LCM Migration → PostgreSQL`);
  log(`SQLite: ${MIGRATION_CONFIG.sqlitePath}`);
  log(`Postgres: ${MIGRATION_CONFIG.connectionString.replace(/:[^@]+@/, ':***@')}`);
  log(`JSONL dirs: ${MIGRATION_CONFIG.agentDirs.join(', ')}`);
  if (DRY_RUN) log('🔍 DRY RUN — no changes will be made');

  const pool = new Pool({ connectionString: MIGRATION_CONFIG.connectionString });

  try {
    // Verify connection
    const res = await pool.query('SELECT 1');
    ok('PostgreSQL connection verified');

    if (!JSONL_ONLY) {
      log('═══ Phase 1: SQLite LCM Data ═══');
      await migrateSqlite(pool);
    }

    if (!SQLITE_ONLY) {
      log('═══ Phase 2: JSONL Session Transcripts ═══');
      await importJsonlSessions(pool);
    }

    // Final stats
    const stats = await pool.query(`
      SELECT 
        (SELECT COUNT(*) FROM conversations) as convos,
        (SELECT COUNT(*) FROM messages) as msgs,
        (SELECT COUNT(*) FROM summaries) as sums,
        (SELECT COUNT(*) FROM message_parts) as parts
    `);
    const s = stats.rows[0];
    log(`═══ Final State ═══`);
    ok(`${s.convos} conversations, ${s.msgs} messages, ${s.sums} summaries, ${s.parts} message parts`);
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error('[migrate] ❌ Fatal:', err);
  process.exit(1);
});

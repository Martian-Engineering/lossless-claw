#!/usr/bin/env node
/**
 * Backfill missing embeddings for messages and summaries.
 * 
 * Uses OpenAI text-embedding-3-small (same as LCM's EmbeddingClient).
 * Batches requests (up to 512 per API call) to stay efficient.
 * Processes in chunks to avoid memory issues with large backlogs.
 * 
 * Usage: LCM_EMBEDDING_API_KEY=sk-... node backfill-embeddings.mjs [--batch 200] [--delay 200]
 */

import pg from "pg";

const DB_URL = process.env.LCM_DB_URL;
if (!DB_URL) {
  console.error("Error: LCM_DB_URL environment variable is required.");
  console.error("  Example: LCM_DB_URL=postgres://user:pass@host:5432/dbname node backfill-embeddings.mjs");
  process.exit(1);
}
const API_KEY = process.env.LCM_EMBEDDING_API_KEY || process.env.OPENAI_API_KEY;
const MODEL = "text-embedding-3-small";
const DIMENSIONS = 1536;
const BASE_URL = "https://api.openai.com/v1";

// CLI args
const args = process.argv.slice(2);
const batchSize = parseInt(args[args.indexOf("--batch") + 1]) || 200;
const delayMs = parseInt(args[args.indexOf("--delay") + 1]) || 200;

if (!API_KEY) {
  console.error("Error: Set LCM_EMBEDDING_API_KEY or OPENAI_API_KEY");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DB_URL, max: 3 });

async function embedBatch(texts) {
  // Truncate to ~7k tokens (~28k chars) — OpenAI limit is 8192 tokens
  const truncated = texts.map(t => t.length > 28000 ? t.slice(0, 28000) : t);
  
  const res = await fetch(`${BASE_URL}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({ model: MODEL, input: truncated, dimensions: DIMENSIONS }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "unknown");
    throw new Error(`Embedding API ${res.status}: ${err}`);
  }

  const json = await res.json();
  return json.data.sort((a, b) => a.index - b.index).map(d => d.embedding);
}

function toVectorLiteral(embedding) {
  return `[${embedding.join(",")}]`;
}

async function backfillTable(table, idCol, contentCol) {
  const countRes = await pool.query(
    `SELECT COUNT(*) as total FROM ${table} WHERE embedding IS NULL AND ${contentCol} IS NOT NULL AND TRIM(${contentCol}) != ''`
  );
  const total = parseInt(countRes.rows[0].total);
  console.log(`\n${table}: ${total} rows missing embeddings`);
  if (total === 0) return 0;

  let processed = 0;
  let errors = 0;
  const skippedIds = new Set();

  while (true) {
    const rows = await pool.query(
      `SELECT ${idCol}, ${contentCol} FROM ${table} 
       WHERE embedding IS NULL AND ${contentCol} IS NOT NULL AND TRIM(${contentCol}) != ''
       ORDER BY ${idCol} LIMIT $1`,
      [batchSize]
    );

    if (rows.rows.length === 0) break;

    // Filter out empty/whitespace and already-skipped rows
    const valid = rows.rows.filter(r => 
      r[contentCol] && r[contentCol].trim().length > 0 && !skippedIds.has(String(r[idCol]))
    );
    if (valid.length === 0) break;

    try {
      const embeddings = await embedBatch(valid.map(r => r[contentCol]));
      const ids = valid.map(r => r[idCol]);
      const vectors = embeddings.map(e => toVectorLiteral(e));

      for (let i = 0; i < ids.length; i++) {
        await pool.query(
          `UPDATE ${table} SET embedding = $1::vector WHERE ${idCol} = $2`,
          [vectors[i], ids[i]]
        );
      }

      processed += valid.length;
      const pct = ((processed / total) * 100).toFixed(1);
      process.stdout.write(`\r  ${processed}/${total} (${pct}%) embedded, ${errors} errors`);
    } catch (err) {
      // Batch failed — fall back to one-at-a-time to skip only the bad rows
      console.error(`\n  Batch error, falling back to row-by-row: ${err.message}`);
      for (const row of valid) {
        try {
          // Aggressive truncation for individual retries (~6k tokens)
          const text = row[contentCol].slice(0, 24000);
          const [emb] = await embedBatch([text]);
          await pool.query(
            `UPDATE ${table} SET embedding = $1::vector WHERE ${idCol} = $2`,
            [toVectorLiteral(emb), row[idCol]]
          );
          processed++;
        } catch (rowErr) {
          if (rowErr.message.includes("429")) {
            // Rate limited — put back in queue by breaking out, will retry next loop
            console.error(`\n  Rate limited, pausing 10s...`);
            await new Promise(r => setTimeout(r, 10000));
            break;
          }
          errors++;
          skippedIds.add(String(row[idCol]));
          console.error(`\n  Skipped ${idCol}=${row[idCol]} (${row[contentCol].length} chars): ${rowErr.message.slice(0, 80)}`);
        }
        if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
      }
    }

    // Rate limit courtesy
    if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
  }

  console.log(`\n  Done: ${processed} embedded, ${errors} errors`);
  return processed;
}

async function main() {
  console.log(`Backfill embeddings — batch=${batchSize}, delay=${delayMs}ms`);
  
  const msgCount = await backfillTable("messages", "message_id", "content");
  const sumCount = await backfillTable("summaries", "summary_id", "content");
  
  console.log(`\nTotal: ${msgCount + sumCount} rows embedded`);
  await pool.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

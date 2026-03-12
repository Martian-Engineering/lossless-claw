#!/usr/bin/env node
/**
 * Backfill embeddings for tool-only messages (empty content, have parts).
 * Synthesizes embeddable text from message_parts, then embeds it.
 */
import pg from "pg";
import https from "https";

const DB = "postgres://lcm_phil:pheon.lcm4@10.4.20.16:5432/phil_memory";
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const MODEL = "text-embedding-3-small";
const BATCH_SIZE = 50;
const DELAY_MS = 500;

if (!OPENAI_KEY) {
  // Try to read from openclaw config
  const fs = await import("fs");
  const confPath = "/home/philbot/.openclaw/openclaw.json";
  const conf = JSON.parse(fs.readFileSync(confPath, "utf8"));
  const key = conf?.plugins?.["lossless-claw"]?.embeddingApiKey
    || conf?.keys?.find(k => k.profile === "openai:default")?.key;
  if (!key) { console.error("No OpenAI API key found"); process.exit(1); }
  process.env.OPENAI_API_KEY = key;
}

const pool = new pg.Pool({ connectionString: DB, max: 3 });

function synthesizeFromParts(parts) {
  const lines = [];
  for (const p of parts) {
    if (p.part_type === "tool_call" || p.tool_name) {
      const name = p.tool_name || "unknown_tool";
      let args = "";
      if (p.tool_input) {
        try {
          const input = typeof p.tool_input === "string" ? JSON.parse(p.tool_input) : p.tool_input;
          // Compact representation of key args
          const pairs = Object.entries(input).map(([k, v]) => {
            const val = typeof v === "string" ? v : JSON.stringify(v);
            return `${k}=${val.slice(0, 200)}`;
          });
          args = " " + pairs.join(" ");
        } catch { args = ""; }
      }
      lines.push(`tool:${name}${args}`);
    } else if (p.part_type === "tool_result") {
      const name = p.tool_name || "tool";
      let output = p.tool_output || p.text_content || "";
      if (output.length > 500) output = output.slice(0, 500) + "…";
      if (output) lines.push(`result:${name} → ${output}`);
    } else if (p.text_content) {
      lines.push(p.text_content.slice(0, 500));
    }
  }
  return lines.join("\n").slice(0, 8000);
}

async function embed(texts) {
  const key = process.env.OPENAI_API_KEY;
  const body = JSON.stringify({ model: MODEL, input: texts });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.openai.com",
      path: "/v1/embeddings",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`,
      },
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        if (res.statusCode !== 200) {
          reject(new Error(`OpenAI ${res.statusCode}: ${data.slice(0, 300)}`));
          return;
        }
        try {
          const json = JSON.parse(data);
          resolve(json.data.map(d => d.embedding));
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function run() {
  // Find messages with no embeddings that have parts
  const { rows: missing } = await pool.query(`
    SELECT m.message_id, m.content
    FROM messages m
    WHERE m.embedding IS NULL
    ORDER BY m.message_id
  `);

  console.log(`Found ${missing.length} messages without embeddings`);

  let embedded = 0, skipped = 0, errors = 0;
  const batches = [];
  
  // Process in batches
  for (let i = 0; i < missing.length; i += BATCH_SIZE) {
    const batch = missing.slice(i, i + BATCH_SIZE);
    const ids = batch.map(r => r.message_id);
    
    // Get parts for all messages in batch
    const { rows: parts } = await pool.query(`
      SELECT message_id, part_type, tool_name, tool_input, tool_output, text_content
      FROM message_parts
      WHERE message_id = ANY($1)
      ORDER BY message_id, ordinal
    `, [ids]);

    // Group parts by message
    const partsByMsg = {};
    for (const p of parts) {
      if (!partsByMsg[p.message_id]) partsByMsg[p.message_id] = [];
      partsByMsg[p.message_id].push(p);
    }

    // Build embeddable texts
    const toEmbed = [];
    for (const msg of batch) {
      let text = msg.content || "";
      if (!text && partsByMsg[msg.message_id]) {
        text = synthesizeFromParts(partsByMsg[msg.message_id]);
      }
      if (!text || text.trim().length === 0) {
        skipped++;
        continue;
      }
      // Truncate to stay within token limits
      if (text.length > 8000) text = text.slice(0, 8000);
      toEmbed.push({ id: msg.message_id, text });
    }

    if (toEmbed.length === 0) continue;

    try {
      const embeddings = await embed(toEmbed.map(t => t.text));
      
      // Batch update
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (let j = 0; j < toEmbed.length; j++) {
          const vec = `[${embeddings[j].join(",")}]`;
          await client.query(
            "UPDATE messages SET embedding = $1 WHERE message_id = $2",
            [vec, toEmbed[j].id]
          );
        }
        await client.query("COMMIT");
        embedded += toEmbed.length;
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }

      console.log(`Batch ${Math.floor(i/BATCH_SIZE)+1}: embedded ${toEmbed.length}, skipped ${skipped} so far, total ${embedded}/${missing.length}`);
    } catch (e) {
      console.error(`Batch error: ${e.message}`);
      errors++;
      // If rate limited, wait longer
      if (e.message.includes("429")) {
        console.log("Rate limited, waiting 30s...");
        await new Promise(r => setTimeout(r, 30000));
        i -= BATCH_SIZE; // Retry this batch
        continue;
      }
    }

    await new Promise(r => setTimeout(r, DELAY_MS));
  }

  console.log(`\nDone: ${embedded} embedded, ${skipped} skipped (no content/parts), ${errors} errors`);
  
  // Final count
  const { rows: [{ count }] } = await pool.query("SELECT count(*) FROM messages WHERE embedding IS NULL");
  console.log(`Remaining without embeddings: ${count}`);
  
  await pool.end();
}

run().catch(e => { console.error(e); process.exit(1); });

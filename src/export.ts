import type { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export type ExportOptions = {
  outputDir: string;
  peerId?: string;
  chatType?: "dm" | "group";
  from?: Date;
  to?: Date;
};

export type ExportResult = {
  filesWritten: number;
  messagesExported: number;
  outputDir: string;
};

interface MessageExportRow {
  message_id: number;
  conversation_id: number;
  peer_id: string | null;
  peer_name: string | null;
  chat_type: string | null;
  channel: string | null;
  role: string;
  content: string;
  created_at: string;
}

/**
 * Format a timestamp for the export line
 */
function formatTime(isoString: string): string {
  const date = new Date(isoString);
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  return `${hours}:${minutes}`;
}

/**
 * Format a date for the filename (YYYY-MM-DD)
 */
function formatDate(isoString: string): string {
  const date = new Date(isoString);
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Format a date for the folder name (YYYY-MM)
 */
function formatYearMonth(isoString: string): string {
  const date = new Date(isoString);
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  return `${year}-${month}`;
}

/**
 * Get the peer name for folder structure
 */
function getPeerFolder(peerName: string | null, peerId: string | null, chatType: string | null): string {
  if (chatType === "group") {
    return peerName || peerId || "unknown-group";
  }
  return peerName || peerId || "unknown";
}

/**
 * Format a single message line
 */
function formatMessageLine(row: MessageExportRow): string {
  const channel = row.channel || "unknown";
  const time = formatTime(row.created_at);
  const name = row.role === "user" ? (row.peer_name || "User") : "Assistant";
  const content = row.content.replace(/\n/g, " ").trim();
  return `[${channel}] ${time} ${name}: ${content}`;
}

/**
 * Export conversations to markdown files organized by peer and date
 */
export function exportConversations(db: DatabaseSync, options: ExportOptions): ExportResult {
  // Build query with filters
  let sql = `
    SELECT 
      m.message_id,
      m.conversation_id,
      c.peer_id,
      ct.peer_name,
      ct.chat_type,
      c.channel,
      m.role,
      m.content,
      m.created_at
    FROM messages m
    JOIN conversations c ON c.conversation_id = m.conversation_id
    LEFT JOIN contacts ct ON ct.peer_id = c.peer_id
    WHERE 1=1
  `;
  
  const params: (string | number)[] = [];

  if (options.peerId) {
    sql += ` AND c.peer_id = ?`;
    params.push(options.peerId);
  }

  if (options.chatType) {
    sql += ` AND ct.chat_type = ?`;
    params.push(options.chatType);
  }

  if (options.from) {
    sql += ` AND m.created_at >= ?`;
    params.push(options.from.toISOString());
  }

  if (options.to) {
    sql += ` AND m.created_at <= ?`;
    params.push(options.to.toISOString());
  }

  sql += ` ORDER BY m.created_at ASC`;

  const stmt = db.prepare(sql);
  const rows = stmt.all(...params) as MessageExportRow[];

  if (rows.length === 0) {
    return {
      filesWritten: 0,
      messagesExported: 0,
      outputDir: options.outputDir,
    };
  }

  // Group messages by peer and date
  const grouped = new Map<string, Map<string, MessageExportRow[]>>();

  for (const row of rows) {
    const chatType = row.chat_type || "dm";
    const peerFolder = getPeerFolder(row.peer_name, row.peer_id, row.chat_type);
    const dateFolder = formatYearMonth(row.created_at);
    const dateFile = formatDate(row.created_at);

    const key = `${chatType}/${peerFolder}/${dateFolder}`;
    if (!grouped.has(key)) {
      grouped.set(key, new Map());
    }
    const dateMap = grouped.get(key)!;
    if (!dateMap.has(dateFile)) {
      dateMap.set(dateFile, []);
    }
    dateMap.get(dateFile)!.push(row);
  }

  // Write files
  let filesWritten = 0;
  let messagesExported = 0;

  for (const [key, dateMap] of grouped) {
    const [chatType, peerFolder, dateFolder] = key.split("/");
    const dirPath = join(options.outputDir, chatType, peerFolder, dateFolder);
    
    for (const [dateFile, messages] of dateMap) {
      // Ensure directory exists
      if (!existsSync(dirPath)) {
        mkdirSync(dirPath, { recursive: true });
      }

      // Build file content
      const lines = messages.map(formatMessageLine);
      const content = lines.join("\n") + "\n";

      // Write file
      const filePath = join(dirPath, `${dateFile}.md`);
      writeFileSync(filePath, content, "utf-8");
      filesWritten++;
      messagesExported += messages.length;
    }
  }

  return {
    filesWritten,
    messagesExported,
    outputDir: options.outputDir,
  };
}

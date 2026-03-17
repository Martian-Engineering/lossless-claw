import type { DatabaseSync } from "node:sqlite";

export type ContactRecord = {
  peerId: string;
  peerName: string | null;
  chatType: "dm" | "group" | null;
};

export type CreateContactInput = {
  peerId: string;
  peerName?: string;
  chatType?: "dm" | "group";
};

interface ContactRow {
  peer_id: string;
  peer_name: string | null;
  chat_type: string | null;
}

function rowToRecord(row: ContactRow): ContactRecord {
  return {
    peerId: row.peer_id,
    peerName: row.peer_name,
    chatType: row.chat_type as "dm" | "group" | null,
  };
}

export class ContactStore {
  constructor(private db: DatabaseSync) {}

  create(input: CreateContactInput): ContactRecord {
    const stmt = this.db.prepare(`
      INSERT INTO contacts (peer_id, peer_name, chat_type)
      VALUES (?, ?, ?)
      ON CONFLICT(peer_id) DO UPDATE SET
        peer_name = COALESCE(excluded.peer_name, contacts.peer_name),
        chat_type = COALESCE(excluded.chat_type, contacts.chat_type)
      RETURNING peer_id, peer_name, chat_type
    `);
    const row = stmt.get(input.peerId, input.peerName ?? null, input.chatType ?? null) as ContactRow;
    return rowToRecord(row);
  }

  get(peerId: string): ContactRecord | null {
    const stmt = this.db.prepare(`
      SELECT peer_id, peer_name, chat_type FROM contacts WHERE peer_id = ?
    `);
    const row = stmt.get(peerId) as ContactRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  getAll(): ContactRecord[] {
    const stmt = this.db.prepare(`
      SELECT peer_id, peer_name, chat_type FROM contacts ORDER BY peer_name, peer_id
    `);
    const rows = stmt.all() as ContactRow[];
    return rows.map(rowToRecord);
  }

  update(peerId: string, updates: { peerName?: string; chatType?: "dm" | "group" }): ContactRecord | null {
    const fields: string[] = [];
    const values: (string | null)[] = [];

    if (updates.peerName !== undefined) {
      fields.push("peer_name = ?");
      values.push(updates.peerName);
    }
    if (updates.chatType !== undefined) {
      fields.push("chat_type = ?");
      values.push(updates.chatType);
    }

    if (fields.length === 0) {
      return this.get(peerId);
    }

    values.push(peerId);
    const stmt = this.db.prepare(`
      UPDATE contacts SET ${fields.join(", ")} WHERE peer_id = ?
    `);
    stmt.run(...values);
    return this.get(peerId);
  }

  delete(peerId: string): boolean {
    const stmt = this.db.prepare(`DELETE FROM contacts WHERE peer_id = ?`);
    const result = stmt.run(peerId);
    return result.changes > 0;
  }
}

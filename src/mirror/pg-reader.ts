import { randomUUID } from "node:crypto";
import { ensureLcmMirrorTable } from "./pg-sink.js";
import { getOrCreatePgPool, loadPg } from "./pg-common.js";

type PgClient = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
  release: () => void;
};

const ensuredSharedKnowledgeUrls = new Set<string>();
const SHARED_SCHEMA_LOCK_KEY = "lcm_shared_knowledge_schema_v1";

const SHARED_KNOWLEDGE_DDL = `
CREATE TABLE IF NOT EXISTS knowledge_roles (
  agent_id    TEXT NOT NULL,
  role        TEXT NOT NULL,
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, role)
);

CREATE INDEX IF NOT EXISTS kr_role_idx ON knowledge_roles (role);

CREATE TABLE IF NOT EXISTS shared_knowledge (
  knowledge_id      UUID PRIMARY KEY,
  owner_agent_id    TEXT NOT NULL,
  visibility        TEXT NOT NULL DEFAULT 'shared' CHECK (visibility IN ('shared', 'restricted', 'private')),
  visible_to        TEXT[] NOT NULL DEFAULT '{}',
  editable_by       TEXT[] NOT NULL DEFAULT '{}',
  title             TEXT,
  content           TEXT NOT NULL,
  source_mirror_ids UUID[] NOT NULL DEFAULT '{}',
  tags              TEXT[] NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sk_visibility_idx ON shared_knowledge (visibility, updated_at DESC);
CREATE INDEX IF NOT EXISTS sk_owner_idx ON shared_knowledge (owner_agent_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS sk_tags_idx ON shared_knowledge USING GIN (tags);
CREATE INDEX IF NOT EXISTS sk_visible_to_idx ON shared_knowledge USING GIN (visible_to);
CREATE INDEX IF NOT EXISTS sk_editable_by_idx ON shared_knowledge USING GIN (editable_by);

CREATE OR REPLACE FUNCTION current_agent_has_role(role_name TEXT) RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
    FROM knowledge_roles
    WHERE agent_id = current_setting('app.agent_id', true)
      AND role = role_name
  )
$$ LANGUAGE sql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION agent_matches_any(arr TEXT[]) RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
    FROM knowledge_roles
    WHERE agent_id = current_setting('app.agent_id', true)
      AND role = ANY(arr)
  )
$$ LANGUAGE sql STABLE SECURITY DEFINER;

ALTER TABLE shared_knowledge ENABLE ROW LEVEL SECURITY;
ALTER TABLE shared_knowledge FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sk_admin_bypass ON shared_knowledge;
DROP POLICY IF EXISTS sk_read_shared ON shared_knowledge;
DROP POLICY IF EXISTS sk_owner_all ON shared_knowledge;
DROP POLICY IF EXISTS sk_read_restricted ON shared_knowledge;
DROP POLICY IF EXISTS sk_update_authorized ON shared_knowledge;
DROP POLICY IF EXISTS sk_delete_authorized ON shared_knowledge;

CREATE POLICY sk_admin_bypass ON shared_knowledge FOR ALL
  USING (current_agent_has_role(current_setting('app.admin_role', true)))
  WITH CHECK (current_agent_has_role(current_setting('app.admin_role', true)));

CREATE POLICY sk_read_shared ON shared_knowledge FOR SELECT
  USING (visibility = 'shared');

CREATE POLICY sk_owner_all ON shared_knowledge FOR ALL
  USING (owner_agent_id = current_setting('app.agent_id', true))
  WITH CHECK (owner_agent_id = current_setting('app.agent_id', true));

CREATE POLICY sk_read_restricted ON shared_knowledge FOR SELECT
  USING (visibility = 'restricted' AND agent_matches_any(visible_to));

CREATE POLICY sk_update_authorized ON shared_knowledge FOR UPDATE
  USING (visibility <> 'private' AND agent_matches_any(editable_by))
  WITH CHECK (visibility <> 'private' AND agent_matches_any(editable_by));

CREATE POLICY sk_delete_authorized ON shared_knowledge FOR DELETE
  USING (visibility <> 'private' AND agent_matches_any(editable_by));
`.trim();

export type SharedKnowledgeVisibility = "shared" | "restricted" | "private";

export type MirrorSearchOptions = {
  query: string;
  agentId?: string;
  since?: Date;
  before?: Date;
  limit?: number;
};

export type MirrorSearchRow = {
  mirrorId: string;
  sessionKey: string;
  conversationId: number;
  agentId: string;
  mode: string;
  content: string;
  capturedAt: Date;
  sourceUrl: string;
};

export type MirrorSearchError = {
  sourceUrl: string;
  message: string;
};

export type MirrorSearchResult = {
  rows: MirrorSearchRow[];
  errors: MirrorSearchError[];
};

export type SharedKnowledgeSearchOptions = {
  agentId: string;
  adminRoleName: string;
  query: string;
  tags?: string[];
  limit?: number;
};

export type SharedKnowledgeWriteInput = {
  agentId: string;
  adminRoleName: string;
  content: string;
  title?: string;
  visibility?: SharedKnowledgeVisibility;
  visibleTo?: string[];
  editableBy?: string[];
  tags?: string[];
  sourceMirrorIds?: string[];
};

export type SharedKnowledgeRow = {
  knowledgeId: string;
  ownerAgentId: string;
  visibility: SharedKnowledgeVisibility;
  visibleTo: string[];
  editableBy: string[];
  title: string | null;
  content: string;
  sourceMirrorIds: string[];
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
};

export type KnowledgeRoleRow = {
  agentId: string;
  role: string;
  grantedAt: Date;
};

function normalizeArray(values: string[] | undefined): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function asDate(value: unknown): Date {
  const date = new Date(String(value ?? ""));
  if (Number.isNaN(date.getTime())) {
    return new Date(0);
  }
  return date;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function toContainsPattern(value: string): string {
  return `%${escapeLikePattern(value)}%`;
}

async function withPgClient<T>(
  connectionString: string,
  fn: (client: PgClient) => Promise<T>,
): Promise<T> {
  const pg = await loadPg();
  const pool = getOrCreatePgPool(pg, { connectionString });
  const client = (await pool.connect()) as PgClient;
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

async function withAgentSession<T>(params: {
  connectionString: string;
  agentId: string;
  adminRoleName: string;
  fn: (client: PgClient) => Promise<T>;
}): Promise<T> {
  return withPgClient(params.connectionString, async (client) => {
    try {
      await client.query("BEGIN");
      await client.query(`SELECT set_config('app.agent_id', $1, true)`, [params.agentId]);
      await client.query(`SELECT set_config('app.admin_role', $1, true)`, [params.adminRoleName]);
      const result = await params.fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // no-op
      }
      throw error;
    }
  });
}

async function ensureSharedKnowledgeSchema(connectionString: string): Promise<void> {
  if (ensuredSharedKnowledgeUrls.has(connectionString)) {
    return;
  }
  await withPgClient(connectionString, async (client) => {
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [SHARED_SCHEMA_LOCK_KEY]);
      await client.query(SHARED_KNOWLEDGE_DDL);
      await client.query("COMMIT");
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // no-op
      }
      throw error;
    }
  });
  ensuredSharedKnowledgeUrls.add(connectionString);
}

export async function ensureSharedKnowledgeTables(connectionString: string): Promise<void> {
  await ensureSharedKnowledgeSchema(connectionString);
}

/** Test helper: clear schema ensure cache so DDL can be re-run in-process. */
export function resetSharedKnowledgeEnsureCacheForTests(): void {
  ensuredSharedKnowledgeUrls.clear();
}

export async function seedKnowledgeRoles(
  connectionString: string,
  roleMap: Record<string, string[]>,
): Promise<void> {
  await ensureSharedKnowledgeSchema(connectionString);
  const assignments: Array<{ agentId: string; role: string }> = [];
  for (const [agentId, roles] of Object.entries(roleMap)) {
    const normalizedAgentId = agentId.trim();
    if (!normalizedAgentId) {
      continue;
    }
    for (const role of normalizeArray(roles)) {
      assignments.push({ agentId: normalizedAgentId, role });
    }
  }
  if (assignments.length === 0) {
    return;
  }
  await withPgClient(connectionString, async (client) => {
    try {
      await client.query("BEGIN");
      for (const assignment of assignments) {
        await client.query(
          `INSERT INTO knowledge_roles (agent_id, role)
           VALUES ($1, $2)
           ON CONFLICT (agent_id, role) DO NOTHING`,
          [assignment.agentId, assignment.role],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // no-op
      }
      throw error;
    }
  });
}

export async function agentHasRole(
  connectionString: string,
  params: { agentId: string; role: string },
): Promise<boolean> {
  await ensureSharedKnowledgeSchema(connectionString);
  const result = await withPgClient(connectionString, async (client) => {
    return client.query(
      `SELECT 1
       FROM knowledge_roles
       WHERE agent_id = $1 AND role = $2
       LIMIT 1`,
      [params.agentId, params.role],
    );
  });
  return result.rows.length > 0;
}

export async function listKnowledgeRoles(connectionString: string): Promise<KnowledgeRoleRow[]> {
  await ensureSharedKnowledgeSchema(connectionString);
  const result = await withPgClient(connectionString, async (client) => {
    return client.query(
      `SELECT agent_id, role, granted_at
       FROM knowledge_roles
       ORDER BY agent_id ASC, role ASC`,
    );
  });
  return result.rows.map((row) => ({
    agentId: asString(row.agent_id),
    role: asString(row.role),
    grantedAt: asDate(row.granted_at),
  }));
}

export async function assignKnowledgeRole(
  connectionString: string,
  params: { agentId: string; role: string },
): Promise<{ created: boolean }> {
  await ensureSharedKnowledgeSchema(connectionString);
  const result = await withPgClient(connectionString, async (client) => {
    return client.query(
      `INSERT INTO knowledge_roles (agent_id, role)
       VALUES ($1, $2)
       ON CONFLICT (agent_id, role) DO NOTHING
       RETURNING agent_id`,
      [params.agentId, params.role],
    );
  });
  return { created: result.rows.length > 0 };
}

export async function revokeKnowledgeRole(
  connectionString: string,
  params: { agentId: string; role: string },
): Promise<{ deleted: boolean }> {
  await ensureSharedKnowledgeSchema(connectionString);
  const result = await withPgClient(connectionString, async (client) => {
    return client.query(
      `DELETE FROM knowledge_roles
       WHERE agent_id = $1 AND role = $2
       RETURNING agent_id`,
      [params.agentId, params.role],
    );
  });
  return { deleted: result.rows.length > 0 };
}

async function searchMirrorInOneDatabase(
  connectionString: string,
  options: MirrorSearchOptions,
): Promise<MirrorSearchRow[]> {
  await ensureLcmMirrorTable(connectionString);
  const queryText = options.query.trim();
  const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 20)));
  const result = await withPgClient(connectionString, async (client) => {
    return client.query(
      `SELECT mirror_id, session_key, conversation_id, agent_id, mode, content, captured_at
       FROM lcm_mirror
       WHERE ($1 = '' OR content ILIKE $2 ESCAPE '\\')
         AND ($3::text IS NULL OR agent_id = $3)
         AND ($4::timestamptz IS NULL OR captured_at >= $4)
         AND ($5::timestamptz IS NULL OR captured_at < $5)
       ORDER BY captured_at DESC
       LIMIT $6`,
      [
        queryText,
        toContainsPattern(queryText),
        options.agentId?.trim() || null,
        options.since?.toISOString() ?? null,
        options.before?.toISOString() ?? null,
        limit,
      ],
    );
  });

  return result.rows.map((row) => ({
    mirrorId: asString(row.mirror_id),
    sessionKey: asString(row.session_key),
    conversationId: asNumber(row.conversation_id),
    agentId: asString(row.agent_id),
    mode: asString(row.mode),
    content: asString(row.content),
    capturedAt: asDate(row.captured_at),
    sourceUrl: connectionString,
  }));
}

export async function searchMirror(
  connectionStrings: string[],
  options: MirrorSearchOptions,
): Promise<MirrorSearchResult> {
  const uniqueUrls = normalizeArray(connectionStrings);
  if (uniqueUrls.length === 0) {
    return { rows: [], errors: [] };
  }
  const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 20)));
  const perDatabaseLimit = Math.max(limit, 20);
  const settled = await Promise.all(
    uniqueUrls.map(async (url) => {
      try {
        const rows = await searchMirrorInOneDatabase(url, {
          ...options,
          limit: perDatabaseLimit,
        });
        return {
          sourceUrl: url,
          rows,
          error: null,
        };
      } catch (error) {
        return {
          sourceUrl: url,
          rows: [] as MirrorSearchRow[],
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );

  const rows = settled
    .flatMap((entry) => entry.rows)
    .sort((a, b) => b.capturedAt.getTime() - a.capturedAt.getTime())
    .slice(0, limit);
  const errors = settled
    .filter((entry): entry is { sourceUrl: string; rows: MirrorSearchRow[]; error: string } =>
      typeof entry.error === "string" && entry.error.length > 0
    )
    .map((entry) => ({
      sourceUrl: entry.sourceUrl,
      message: entry.error,
    }));
  return { rows, errors };
}

function mapSharedKnowledgeRow(row: Record<string, unknown>): SharedKnowledgeRow {
  return {
    knowledgeId: asString(row.knowledge_id),
    ownerAgentId: asString(row.owner_agent_id),
    visibility: asString(row.visibility) as SharedKnowledgeVisibility,
    visibleTo: normalizeArray((row.visible_to as string[] | undefined) ?? []),
    editableBy: normalizeArray((row.editable_by as string[] | undefined) ?? []),
    title: typeof row.title === "string" ? row.title : null,
    content: asString(row.content),
    sourceMirrorIds: normalizeArray((row.source_mirror_ids as string[] | undefined) ?? []),
    tags: normalizeArray((row.tags as string[] | undefined) ?? []),
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at),
  };
}

export async function writeSharedKnowledge(
  connectionString: string,
  input: SharedKnowledgeWriteInput,
): Promise<SharedKnowledgeRow> {
  await ensureSharedKnowledgeSchema(connectionString);
  const knowledgeId = randomUUID();
  const visibility = input.visibility ?? "shared";
  const visibleTo = normalizeArray(input.visibleTo);
  const editableBy = normalizeArray(input.editableBy);
  const tags = normalizeArray(input.tags);
  const sourceMirrorIds = normalizeArray(input.sourceMirrorIds);

  const result = await withAgentSession({
    connectionString,
    agentId: input.agentId,
    adminRoleName: input.adminRoleName,
    fn: (client) =>
      client.query(
        `INSERT INTO shared_knowledge (
           knowledge_id, owner_agent_id, visibility, visible_to, editable_by, title, content, source_mirror_ids, tags
         ) VALUES ($1::uuid, $2, $3, $4::text[], $5::text[], $6, $7, $8::uuid[], $9::text[])
         RETURNING
           knowledge_id, owner_agent_id, visibility, visible_to, editable_by, title, content,
           source_mirror_ids, tags, created_at, updated_at`,
        [
          knowledgeId,
          input.agentId,
          visibility,
          visibleTo,
          editableBy,
          input.title?.trim() || null,
          input.content,
          sourceMirrorIds,
          tags,
        ],
      ),
  });
  return mapSharedKnowledgeRow(result.rows[0] ?? {});
}

export async function searchSharedKnowledge(
  connectionString: string,
  options: SharedKnowledgeSearchOptions,
): Promise<SharedKnowledgeRow[]> {
  await ensureSharedKnowledgeSchema(connectionString);
  const queryText = options.query.trim();
  const tags = normalizeArray(options.tags);
  const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 10)));

  const result = await withAgentSession({
    connectionString,
    agentId: options.agentId,
    adminRoleName: options.adminRoleName,
    // Defense in depth: keep visibility checks in-query so superuser/BYPASSRLS
    // sessions do not leak restricted rows even when table RLS is bypassed.
    fn: (client) =>
      client.query(
        `SELECT
           knowledge_id, owner_agent_id, visibility, visible_to, editable_by, title, content,
           source_mirror_ids, tags, created_at, updated_at
         FROM shared_knowledge
         WHERE ($1 = '' OR COALESCE(title, '') ILIKE $2 ESCAPE '\\' OR content ILIKE $2 ESCAPE '\\')
           AND ($3::text[] IS NULL OR tags @> $3::text[])
           AND (
             current_agent_has_role(current_setting('app.admin_role', true))
             OR visibility = 'shared'
             OR owner_agent_id = current_setting('app.agent_id', true)
             OR (visibility = 'restricted' AND agent_matches_any(visible_to))
           )
         ORDER BY updated_at DESC
         LIMIT $4`,
        [
          queryText,
          toContainsPattern(queryText),
          tags.length > 0 ? tags : null,
          limit,
        ],
      ),
  });

  return result.rows.map((row) => mapSharedKnowledgeRow(row));
}

export { ConversationStore } from "./conversation-store.js";
export type {
  ConversationId,
  MessageId,
  SummaryId,
  MessageRole,
  MessagePartType,
  MessageRecord,
  MessagePartRecord,
  ConversationRecord,
  CreateMessageInput,
  CreateMessagePartInput,
  CreateConversationInput,
  MessageSearchInput,
  MessageSearchResult,
} from "./conversation-store.js";

export { SummaryStore } from "./summary-store.js";
export type {
  SummaryKind,
  ContextItemType,
  CreateSummaryInput,
  SummaryRecord,
  ContextItemRecord,
  SummarySearchInput,
  SummarySearchResult,
  CreateLargeFileInput,
  LargeFileRecord,
  UpsertConversationBootstrapStateInput,
  ConversationBootstrapStateRecord,
} from "./summary-store.js";



// Database interface exports
export { Dialect } from "../db/dialect.js";
export type { Backend } from "../db/dialect.js";
export { DbClient } from "../db/db-interface.js";
export { SqliteClient } from "../db/sqlite-client.js";
export { PostgresClient } from "../db/postgres-client.js";
export { createLcmConnection, closeLcmConnection, getLcmConnection } from "../db/connection.js";
export { getLcmDbFeatures } from "../db/features.js";
export { runLcmMigrations, ensurePostgresSchema } from "../db/migration.js";
export { resolveLcmConfig } from "../db/config.js";
export type { LcmConfig } from "../db/config.js";
export type { LcmDbFeatures } from "../db/features.js";

// Embedding exports
export { EmbeddingClient, toVectorLiteral, fromVectorLiteral } from "../embeddings.js";
export type { EmbeddingConfig } from "../embeddings.js";
---
"lossless-claw": minor
---

Add embedding-based semantic search with pgvector support

- EmbeddingQueue for async background embedding of messages and summaries
- Retrieval module with recency-boosted semantic search and agent affinity
- pgvector column and HNSW index management in Postgres migration
- Agent registry for cross-agent memory sharing
- Backfill scripts for existing messages and tool embeddings
- Configurable embedding provider via LCM_EMBEDDING_* env vars

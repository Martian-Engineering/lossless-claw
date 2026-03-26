---
"lossless-claw": minor
---

Add PostgreSQL backend support alongside existing SQLite.

- DbClient interface abstracting SQLite and Postgres
- SqliteClient/PostgresClient implementations
- Dialect class for SQL parameter/syntax differences
- Postgres full-text search with tsquery sanitization
- AsyncLocalStorage-based transactions
- Migration script with CLI flags (no hardcoded credentials)
- Singleton plugin registration to prevent duplicate embedding queues
- better-sqlite3 as optional dependency for migration script

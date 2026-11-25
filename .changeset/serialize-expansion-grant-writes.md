---
"@martian-engineering/lossless-claw": patch
---

Serialize delegated expansion grant writes with the database's other transactions. Grants share the plugin's SQLite connection, and a grant created, revoked or metered while another operation held a transaction open across file I/O joined that transaction: if it rolled back, a revoked grant became active again or a new grant disappeared. Grant writes now wait for open transactions to finish and commit on their own.

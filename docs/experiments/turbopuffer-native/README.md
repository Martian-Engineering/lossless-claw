# Native Turbopuffer storage for Lossless Claw

This experimental backend stores LCM state directly in Turbopuffer through native repositories. SQLite remains the default backend. The [fork implementation PR](https://github.com/PandelisZ/lossless-claw/pull/3) contains the corresponding fork work and evidence; this proposal retains upstream package identity and release metadata. Native mode requires explicit configuration and a new namespace.

## Storage and lifecycle

Native mode stores messages, parts and provenance; summaries and ordered source/parent edges; active context; pending compaction batches and inference leases; transcript cursors, replay identities and gaps; focus briefs; compaction telemetry/maintenance; turn receipts; expansion grants, bindings and consumption; and externalized text/binary bytes in Turbopuffer. There is no PostgreSQL dependency, SQLite projection, Rails persistence, external queue or embedding service in this path.

The existing assembler, compactor, transcript-delta synchronization, publisher and retrieval algorithms consume repository contracts. Native mode supplies those contracts directly. Gateway registration routes each host-owned agent identity to its own namespace and admitted writer. The agent can retain multiple conversations; tool parameters cannot select another namespace. A different agent cannot inherit the parent's memory through a delegated grant.

The native path does not register the SQLite context-explorer/repair UI or SQLite backup/repair slash commands. Programmatic status and doctor, session actions and `/lcm status` / `/lcm doctor` use the native backend. Doctor currently checks publication/index progress; it is not the exhaustive SQLite doctor. These administrative differences are explicit; no hidden SQLite handle is supplied to them.

## Publication protocol

1. A bounded root document contains an immutable tree ID, revision, writer fence and indexed-prefix watermark. It contains neither history nor a growing receipt/edge array.
2. Immutable entity versions and 64-entry ordered tree pages are written under content-addressed IDs. Large values use 2 MiB chunks and a paged chunk index. Context positions are sparse internally; public ordinals remain dense. Replacing a prefix does not rewrite the unchanged tail.
3. One conditional root patch publishes the complete new tree. Its condition checks both revision and the admitted writer token. An older writer cannot acquire the current token by reloading the root. A rejected publication leaves unreachable records; it does not expose a partial graph. Context replacement also verifies that the summary source coverage still equals the committed slice, rejecting inference completed against stale context.
4. Receipts and a paged change journal are part of the committed tree. A lost publication reply is reconciled through the receipt. A write whose outcome remains ambiguous is reported as unknown; callbacks/inference are not automatically replayed.
5. Only committed journals materialize native BM25/regex search documents. Birth/death revisions preserve pinned search visibility. Index inserts are conditional on absence, so replay cannot erase a later death marker. The index watermark advances only after every materialization write is durable.
6. Fresh clients repair a committed but incomplete index prefix before searching. Search fails on provider errors rather than downgrading consistency. Exact/context reads use the immutable committed tree independently of search materialization.

Turbopuffer conditions are evaluated per document. The protocol deliberately relies on a condition on one root, rather than pretending that a rejected condition rolls back other documents in the batch. Strong consistency is explicit on every provider query. This follows the documented [guarantees](https://turbopuffer.com/docs/guarantees), [conditional writes](https://turbopuffer.com/docs/write#conditional-writes) and [query consistency](https://turbopuffer.com/docs/query#param-consistency).

One admitted writer instance per agent serializes storage transactions in memory, analogous to the upstream connection's transaction mutex. Concurrent agent conversations can perform inference separately; their root publications serialize. This is a throughput bottleneck for one very busy agent, not a provider-wide scalability limit. A later process initialization fences the old writer. This experiment does not establish availability or capacity under continuous writer takeover.

## Limits and growth

There is no 16 MiB conversation snapshot, 512-receipt or 10,000-record history limit. Canonical records and receipts are paged; exports and ordered scans traverse keys beyond a provider query page. Caches are disposable and bounded (the HTTP immutable cache is at most 4,096 records / 32 MiB); the durable history is not a cache.

Actual [provider limits](https://turbopuffer.com/docs/limits) still apply: 8 MiB attribute values, 64 MiB documents, 64-byte document IDs, 4 KiB filterable values, 512 MB upsert requests and 10,000 results per query. Internal IDs are fixed hashes, long values are chunked, and ordinary requests target 8 MiB batches. Full-text queries have an 8,192-character provider limit. Literal/CJK and guarded JavaScript regex fallback scans traverse committed native records without the upstream SQLite regex scan's 10,000-row ceiling. They can be expensive. Native `word_v2` BM25/tokenization and scores are not identical to SQLite FTS5. The hybrid rank adds a native time-decay boost to lexical relevance; it is an adaptation of the upstream policy, not numerically identical BM25 scores.

Large searchable records have a separate committed overflow index. Their complete content is checked for terms/phrases spanning provider chunks, rather than silently losing those matches. This overflow check uses case-insensitive literal AND/phrase matching, so punctuation and Unicode token boundaries can differ from `word_v2` and SQLite FTS5; it does not establish exact tokenizer parity. Exact regex semantics, including JavaScript features unavailable in RE2, use the upstream regex safety guard and a native canonical scan. Native RE2 filtering is also exercised by the provider protocol probe.

An unsharded namespace has the provider's 1 TB / 500M-document sizing envelope. The optional `numShards` setting selects 1–256 shards on the first write; it cannot be changed in place. The documented sharded maximum is 256 TB / 128B documents per namespace. The prototype has not been capacity-tested at those sizes. Agents have separate namespaces. See [sharding](https://turbopuffer.com/docs/sharding) and [namespaces](https://turbopuffer.com/docs/namespaces).

The protocol retains prior committed versions and unreachable losing writes. There is no automatic garbage collector. Consequently write amplification and retained bytes grow with mutations. A safe collector must account for retained pinned roots, committed-but-unindexed journals, receipts and in-flight writer generations; age alone is insufficient. No user records are automatically discarded. An explicit future vacuum can rebuild only reachable state into a new namespace, verify it, fence writers and switch atomically. Until implemented, long-running deployments incur accumulated storage cost.

## Search visibility, pagination and cost

Indexing only published commits avoids losing writers polluting candidate sets. Ordinary search filters a fully materialized committed prefix, so correctness does not depend on a fixed overfetch multiplier. Search pages exclude already returned provider IDs; ordered canonical exports use tree key ranges. Provider request limits and query payload size still bound an individual request, not the stored corpus. Large result requests and unsupported-regex/CJK fallback paths require more I/O and memory than ordinary top-50 recall.

Every remote tree or entity read is real provider I/O unless the immutable ID is already in a bounded memory cache. Warm and fresh-client measurements must be separated. A cache hit cannot hide a root publication: mutable heads always hit the API. A response object cache is not durable storage.

The [current pricing](https://turbopuffer.com/pricing) has a 1.28 GB minimum queried-byte charge per query and a 10 KB minimum per write, even for tiny namespaces. At the listed Launch/Scale rate of $1 per PB queried, that query floor is $0.00000128 per query, or $1.28 per million queries, before returned-byte charges and subscription minimums. Thousands of tiny tree reads amplify this floor despite little returned data. Billing counters, network rounds and returned bytes belong beside latency results. No paid plans, pinning, replicas, embeddings or reranking were enabled for this experiment.

Namespace branching was considered: it offers independent snapshot visibility, but costs $0.032 per branch and bills logical storage per branch, and is currently unavailable on sharded namespaces. A branch per turn would be an unnecessary cost and scaling constraint. See [branching](https://turbopuffer.com/docs/branching).

## Opt-in configuration

OpenClaw's supported stable minimum remains `2026.9.2`. This uses the existing asynchronous context-engine factory contract, not a new host API. Place the key in the worker process environment; never in plugin JSON, CLI arguments or fixture files.

```json
{
  "plugins": {
    "slots": { "contextEngine": "lossless-claw" },
    "entries": {
      "lossless-claw": {
        "config": {
          "storageBackend": "turbopuffer",
          "turbopuffer": {
            "organizationId": "operator-owned-organization",
            "namespacePrefix": "lcm-native-trial",
            "region": "aws-us-east-1",
            "apiKeyEnv": "LCM_TURBOPUFFER_API_KEY"
          }
        }
      }
    }
  }
}
```

`numShards` is optional and immutable after namespace creation. `LCM_STORAGE_BACKEND` may override `storageBackend`; all other native authority settings come from trusted plugin configuration. Agent IDs come from configured OpenClaw agents and host session context. Unknown/conflicting host identities fail closed. The new namespace starts empty: changing this setting does not import an existing SQLite file.

## Migration and rollback

Pause the agent's writer before export/cutover. Preserve the original SQLite file and external payload directory. Never point an experiment at an existing unrelated namespace. `importCanonicalTables` accepts an operator-owned canonical archive into a new namespace, preserving message/summary IDs and timestamps. It rejects nonempty unsupported auxiliary tables instead of silently dropping active pending/cursor/grant state. External file metadata is not file bytes; those bytes must be copied explicitly with `storeLargeFileBytes`. This is an archive importer, not an unattended migration of every possible existing SQLite installation.

`exportNative` / `restoreNative` cover the native key/value lifecycle state, including receipts, pending work, cursors and grants, at one pinned root. Restore requires a new namespace with the same organization/agent authority. New publication journals are rebuilt; old user/entity state is retained. Exports are operator-requested artifacts, not a local canonical cache.

Before accepting new native turns, rollback is simply selecting the preserved SQLite backend again. After native writes occur, switching to the old SQLite file alone loses visibility of those new turns: export/reconcile them into the chosen backend first. Automated native-to-SQLite rollback and active-auxiliary SQLite migration are remaining work. No production migration or deployment is part of this branch.

## Measured comparison

Both paired runs used a disposable EC2 `c7i.large` in `us-east-1a`, Turbopuffer `aws-us-east-1` over HTTPS, and PostgreSQL 18 in a loopback Docker container limited to 2 CPUs / 768 MiB. SQLite ran in the same Node process. This is a same-region application experiment, **not** equivalent network placement for a managed remote PostgreSQL service. No production service was modified.

The selected agent has 1,200 messages, 210 summaries and 570 context entries across six conversations. The PostgreSQL adapter has the complete six-agent fixture and scopes through its organization/agent indexes; Turbopuffer has one agent namespace. The SQLite implementation and source shared with the PostgreSQL adapter are pinned to `51c3c90bfe82fa649e4895dd1a2c4874b5e28f76`; the separate PostgreSQL fork is `1eebd7e273716799c6ffbbdf78bb1dd5b913f1b0`. This is the actual PostgreSQL adapter, not the earlier hybrid search mirror. The exported fixture generator was originally pinned to `4bd12aa198c4903f6400a42fa00fa0efc6697063`; its hash/counts below identify the input independently.

Times below are **p50 / p95 / max milliseconds**. Counts are deliberately small; p95 equals max here. Concurrency is one except the explicit three-conversation group. Fully hydrated assembly produced identical output with SHA-256 `d707aba9910cbf2e1e174db6ea36def0cf5a7ea95a8871de37c9f7275315ea01` on all three backends. Metadata-only context is reported separately.

| Equivalent operation | n | SQLite | PostgreSQL adapter | Native Turbopuffer | TP HTTP rounds per sample |
| --- | ---: | --- | --- | --- | --- |
| Context metadata | 5 | 0.17 / 0.27 / 0.27 | 1.80 / 5.14 / 5.14 | 19.72 / 37.09 / 37.09 | 1 |
| Recent 80 messages (below 256 KiB) | 5 | 0.53 / 1.23 / 1.23 | 2.15 / 5.28 / 5.28 | 19.96 / 55.71 / 55.71 | 3 first, then 1 |
| Hydrated assembly, warm client (focused run) | 3 | 6.57 / 9.29 / 9.29 (n=5, matrix) | 11.51 / 20.18 / 20.18 | 23.90 / 30.41 / 30.41 | 1 |
| Hydrated assembly, fresh TP client | 3 | — | — | 324.02 / 358.11 / 358.11 | 17 |
| Message full-text recall, recency order | 5 | 1.85 / 2.96 / 2.96 | 2.06 / 3.48 / 3.48 | 33.15 / 35.61 / 35.61 | 2 |
| Source DAG traversal to message IDs (not hydrated messages) | 5 | 1.21 / 1.37 / 1.37 | 20.15 / 24.16 / 24.16 | 21.75 / 248.76 / 248.76 | 17 first, then 1 |
| Atomic two-message append + context + receipt | 3 | — | 5.52 / 23.39 / 23.39 | 409.35 / 621.72 / 621.72 | 9 first, then 8 |
| Same turn receipt replay | 3 | — | 0.49 / 0.68 / 0.68 | 15.52 / 19.91 / 19.91 | 1 |
| Actual upstream leaf compactor, fake inference (focused run) | 3 | — | 22.42 / 43.23 / 43.23 | 399.05 / 967.11 / 967.11 | 7 |

PostgreSQL round trips are 1 for metadata/tail/batched assembly/search, 42 for the source traversal, 13 for append, 4 for receipt replay and 11 for actual compaction. The traversal is the adapter's repeated source-edge calls; it is not the earlier ~1-second recursive mirror query. Batched graph expansion could improve either remote adapter. SQLite write/compactor timings were not measured in this matrix.

Three simultaneous independent conversations completed as a group in 21.99 ms / 39 PostgreSQL queries versus 1,073.16 ms / 15 TP requests (n=1 group, individual TP latencies 338.14 / 702.18 / 1,073.12 ms). The agent root serializes publication. Native fixture import took 2,269.97 ms / 41 requests (focused run, n=1); this is batched archive loading, not per-message append throughput. Native additive hybrid recall took 45.24 / 47.14 / 47.14 ms (n=3), with explicitly different ranking semantics.

The first complete matrix found 195 remote reads per native leaf compaction and 63 per fresh-client assembly. A narrowly scoped follow-up pinned the compactor read phase and indexed trusted transcript anchors; the focused evidence above supersedes those two native cases (195→7 and 63→17 requests). All earlier raw samples remain in `evidence/ec2-native-comparison.json`; final affected samples are in `evidence/ec2-native-focused-comparison.json`. A fresh client is an empty application cache against an already warm provider namespace, **not** a cold object-storage benchmark. The first post-import assembly in the focused run was 49.16 ms / 2 requests (n=1).

Retrieval has no inference. Compaction uses the real upstream algorithm, source/context commit and real backend I/O, with a deterministic fake summary only at the inference boundary. Each raw sample records `inferenceMs`, `inferenceCalls` and `dbAndAlgorithmMs`; the table is wall-clock including that near-zero fake callback. This does not predict paid LLM latency. Append ordering, duplicate turn counts, retained raw messages, matching recall IDs, and independent agent/organization namespaces are asserted before success. Protocol evidence separately covers crash/restart and competing-writer behavior.

### Metered work and recommendation

The complete matrix recorded 983 requests, 1,276,160,000,000 billable queried bytes, 8,534,418 written bytes and 3,209,130 returned bytes. The focused follow-up recorded 139 requests, 180,480,000,000 queried bytes, 8,175,836 written bytes and 2,573,176 returned bytes. These include setup/import/recovery/cleanup, not just timed reads; zero metric records were dropped. Conditional writes can contain nested query charges, which are included in these totals. Network JSON byte counts are recorded separately and are not billing bytes.

At the public reference rates ($1/PB queried, $2/GB written and $0.05/GB returned), these API counters correspond to about **$0.01851** and **$0.01666** respectively, excluding retained storage, EC2, subscription minimums and any account-specific rates. Queried-byte charges alone are $0.00127616 / $0.00018048 despite a tiny fixture, illustrating the 1.28 GB per-query floor. This is an estimate from provider counters, not an invoice.

A fully Turbopuffer-owned canonical store is feasible at the demonstrated scope; the previous small-snapshot limits were adapter choices. It is a useful experimental alternative when managed document/search storage and agent namespace isolation are desired. SQLite remains the lowest-overhead local choice, and this PostgreSQL adapter is faster for these transactional operations. The native TP protocol adds tree/journal amplification, serialized publication per agent, cold-client reads and retained-version costs. Before recommending broad deployment, implement operator-controlled vacuum, complete migration/admin workflows, and test prolonged contention, large histories, outages and provider-cold behavior. The experiment proves neither web-scale throughput nor production readiness.

## Reproduction and evidence

Use `mise exec -- npm run build:turbopuffer-native` and `mise exec -- npm run build:native-engine`. Native contracts live in `test/turbopuffer-native-*.test.ts`; the complete upstream suite remains enabled. `scripts/turbopuffer-native/protocol-probe.mjs` exports a live probe accepting a key in memory and unique synthetic namespaces; `compare.mjs` consumes the shared seed-20261104 fixture and read-only PostgreSQL experiment export. Provider namespaces are cleaned up in `finally` and recorded in evidence.

The initial protocol evidence covers 10,020 actual native messages, keyset traversal, BM25/RE2, losing-writer fencing, crash before publication, lost publication response, committed index repair by a fresh client and two-agent isolation. The first probe exposed an ANY-token canary-query bug; both the failed evidence and corrected successful run are retained. These are protocol measurements, not full engine performance claims.

The shared fixture SHA-256 is `af724fb7cd2504ac3e593b16090d63179bdd0ee25e3617991e25d8be14f2b5cf` (7,039,271 exported bytes; 7,200 messages / 2,880,000 message-content bytes, 1,260 summaries, 7,200 message edges, 1,224 parent edges and 3,420 context items across two organizations and six agents). Benchmark reports distinguish the selected agent's namespace from total fixture counts and distinguish metadata from hydrated context and source-message expansion. PostgreSQL mirror timings from the earlier hybrid experiment are not the parallel PostgreSQL adapter's timings.

See the adjacent evidence files and documentation provenance manifest. A successful small probe is not proof of production readiness, complete administrative feature parity or web-scale throughput.


The live lifecycle probe (`scripts/turbopuffer-native/lifecycle-probe.mjs`) replaces the Node SQLite connection constructor with a throwing stub, then exercises the real engine against TP: bootstrap, commit/dedup, assembly, reconstructed engine and persisted expansion grants. `evidence/native-lifecycle-deny-sqlite.json` records success with both ESM and CommonJS SQLite constructors blocked and verifies that the guard itself throws. The earlier EC2 lifecycle run is retained as `ec2-native-lifecycle-incomplete-guard.json`: review found its CommonJS monkey patch did not affect Node’s ESM SQLite export, so it does not prove the no-connection claim. The corrected lifecycle probe was rerun independently against real TP from the local client; it is not a same-region performance sample. The provider protocol probe and lifecycle were run separately from the benchmark so fault injection does not contaminate timings. Exact tested payload file hashes are recorded in the adjacent `*-artifacts.json` files. All experiment namespaces, EC2 instances, security groups and SSH key registrations were deleted after evidence collection; only resources created by this task were touched.

To run the lifecycle probe, first bundle its existing fake transcript host:

```sh
mise exec -- npx esbuild test/transcript-delta-fake-host.ts --bundle --platform=node --format=esm --outfile=dist/experimental/turbopuffer-fake-host.js
```

Import `lifecycle(apiKey)`, `probe({apiKey, output})` or `compare({apiKey, manifestPath, postgresPath, output, clientLocation, focused})` from their scripts in a short-lived Node process. Supply the credential through the approved secret tool into process memory or stdin, never a command argument or fixture. `focused: true` runs only import, warm/fresh assembly and real compaction; the default is the complete matrix. The manifest resolves the synthetic fixture and verifies its SHA-256 before loading. `postgresPath` is a **read-only** generated adapter export at the pinned commit above, with its built upstream bundle, provenance and schema; the comparator fails if the source pin differs. Connection settings use the PostgreSQL driver's ordinary process environment against a disposable database. Do not point this harness at production.


Local verification: TypeScript (core and UI), the complete upstream/default-plus-native suite (**142 files / 2,196 tests**, `--maxWorkers=2`), all package builds, Go TUI tests, and npm pack dry-run passed. The busy shared host caused three existing 5-second test timeouts at four workers; the two-worker run passed without changing any timeout or assertion. The OpenClaw inspector reported PASS / zero breakages, with two proof gaps (isolated dependency installation and registration capture); it does not establish a live gateway deployment. Native engine and router tests cover the existing supported host contracts, and the live lifecycle probe uses a deterministic transcript host. No native rewrite has been merged, published to npm or deployed by this evidence run.

The clean upstream proposal was separately built and typechecked from upstream `51c3c90bfe82fa649e4895dd1a2c4874b5e28f76`, retaining its package metadata and excluding the previous projection adapter. Its complete suite passes **141 files / 2,180 tests** with two workers; the fork suite above additionally includes the older adapter tests.

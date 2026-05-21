# Traceroot.ai — Fundamental Scaling Assessment

Research-backed assessment of Traceroot's current scaling architecture vs. Langfuse (primary), SigNoz, Opik, and Arize Phoenix. Grounded in code (clone `C:\tmp\traceroot-pr-913`, file/line refs) and primary-source competitor research. No production code changed.

---

## TL;DR

Traceroot already has the **right backbone**: an async ingestion gateway (write to S3, enqueue to Celery, return fast) — the same shape Langfuse converged on. The gaps are in the layers *around* that backbone: the queue is unbounded with no backpressure, ClickHouse writes are not aggregated across requests (too-many-parts risk), the async ingest path does blocking I/O, quota is hour-laggy, and the whole platform sits on a single-node ClickHouse with no autoscaling.

**The #1 likely first production failure is ClickHouse "too many parts"** from one small insert per SDK flush. **The #1 correctness risk is silent data loss** (swallowed enqueue failures + no DLQ + drop-after-retry). Both are fixable without re-architecting.

---

## Current architecture (verified from code)

```
SDK (OTLP/proto, gzip, batch 100 spans / 5s)
  -> POST /api/v1/public/traces  [FastAPI, async]
       - auth: SYNC HTTP -> Next.js validate-api-key -> Postgres READ + WRITE(lastUseTime)  [per request]
       - quota: auth.ingestion_blocked (stored bool, refreshed HOURLY)  -> 402
       - body -> gunzip -> decode OTLP -> S3 put (BLOCKING boto3, + head_bucket per req)
       - process_s3_traces.delay()  [Celery, Redis broker, UNBOUNDED]   (enqueue errors swallowed)
  -> Celery worker (prefork, no concurrency cap, prefetch x4, no time limits, single queue)
       - download S3 -> SELECT ... FROM traces FINAL (read-before-write) -> ClickHouse insert (1 HTTP insert/file, no async_insert)
       - publish live spans via Redis pub/sub (new connection per task)
  -> ClickHouse: ReplacingMergeTree, 1 shard / 1 replica / no Keeper; reads use FINAL everywhere
```

Good foundations already present: async gateway shape, S3 as raw store, `ReplacingMergeTree` (matches Langfuse/Opik), per-task batched insert (not row-by-row), live tracing over Redis pub/sub (works across replicas), stateless REST tier.

---

## Gap matrix: Traceroot vs. the field

| Layer | Traceroot today | Langfuse | SigNoz | Opik | Phoenix |
|---|---|---|---|---|---|
| Ingest shape | async S3+Celery ✓ | async S3+BullMQ | collector+Kafka | async batch API | bounded deque |
| Queue bound / backpressure | **none (unbounded, swallowed errors)** | metric-driven (also unbounded) | memory_limiter + sending_queue (+Kafka) | R2DBC backpressure | **deque full → 503/RESOURCE_EXHAUSTED** |
| CH write batching | **per-task only (per SDK flush)** | **in-mem accumulator: 1000 rows / 1000ms + async_insert** | **batch proc: 10k rows / 10s** | **async_insert=1** | max_ops_per_transaction |
| CH durability/scale | **1 shard / 1 replica / no Keeper** | Replicated, vertical + read replica | 3 shard x 3 replica | replicated | SQLite/PG |
| Rate limiting | none today (PR #565 = flat req-count) | **plan + per-org override, per-resource, sliding window** | n/a (collector) | per-workspace+user, event-count | IP (login only) |
| Quota enforcement | **hourly, eventually-consistent; paid uncapped** | per-org real-time | n/a | usage-limit interceptor | DB-disk monitor |
| Backpressure response | none | 429 + Retry-After + X-RateLimit-* | 503/RESOURCE_EXHAUSTED | 429 + reset headers | 429/503/507; gRPC FAILED_PRECONDITION for permanent |
| Horizontal scaling | **1 replica each, no HPA** | web/worker split + scale on CPU | collector HPA | backend HPA | single-node |
| Read path | **FINAL everywhere** | skinny MV, skip-FINAL for OTel, keyset pagination, time-pruning required | ts_bucket pre-bucketing | UUIDv7 ordering | n/a |

---

## OTLP contract (authoritative — defines the request pattern you receive)

- Traceroot's TS SDK uses the stock OTel `OTLPTraceExporter` + `BatchSpanProcessor`. Defaults: **flush 100 spans / 5s**, export timeout 30s, **maxQueueSize 2048 (silently drops over that)**.
- Exporter **honors `Retry-After`** and retries on **429/502/503/504** with capped exponential backoff (5 attempts, ≤5s). It will **drop the batch** if backpressure persists past the 30s export deadline.
- Implication: to make clients back off gracefully (instead of dropping), the server MUST return **429/503 with `Retry-After`** under load — never 500 (non-retryable). And because clients retry, ClickHouse inserts must be **idempotent** (`insert_deduplicate=1` / ReplacingMergeTree on trace_id+span_id).

---

## Prioritized roadmap

### Tier 0 — Correctness & availability (before scaling traffic)

**0.1 Bound the queue + edge backpressure + stop silent data loss.**
- Add a queue high-water check; when exceeded, return **429 + Retry-After** at the ingest endpoint (shed at the edge where the SDK can retry). Model: Phoenix `is_full → 503`; SigNoz `memory_limiter`.
- Replace swallowed `.delay()` failures with a durable path: on enqueue failure, the S3 object already exists — add an **orphan-S3 reconciliation sweeper** (periodic Celery beat) and/or a **DLQ** so a Redis blip doesn't drop traces from ClickHouse. (Langfuse's own gap: it drops after 3 attempts with no DLQ — do better.)
- Files: `backend/rest/routers/public/traces.py:231-235`, `backend/worker/celery_app.py`.

**0.2 Aggregate ClickHouse writes across requests + async_insert.** *(highest write-path leverage)*
- Don't insert once per S3 file. Introduce a **buffer/accumulator** that flushes on size or interval (Langfuse: 1000 rows / 1000ms; SigNoz: 10k / 10s), and/or enable ClickHouse **`async_insert=1, wait_for_async_insert=1`** (Opik's approach) so the server coalesces small inserts. Add `insert_deduplicate=1` for safe client retries.
- Prevents the **"too many parts"** failure (the first thing that breaks at volume). Files: `backend/db/clickhouse/client.py:113`, `backend/worker/ingest_tasks.py:133-139`.

**0.3 De-block the async ingest path.**
- Wrap blocking boto3 (`upload_json`, and drop the per-request `head_bucket`) in `asyncio.to_thread`/threadpool; do bucket-existence once at startup.
- **Cache API-key validation** (Redis, short TTL) and stop the **per-request Postgres `lastUseTime` write** (batch/throttle it). Currently every ingest = a Postgres read+write + a blocking HTTP round-trip.
- Unlocks per-replica REST throughput. Files: `traces.py:73-84,219-220`; `frontend/ui/src/app/api/internal/validate-api-key/route.ts:70-73`.

### Tier 1 — Tenant fairness & multi-replica

**1.1 Plan/org-tiered rate limits (evolve PR #565).** Per-**resource** buckets (ingestion vs read-API vs delete), keyed by **validated org/project** (not a client header), with **Redis-cached per-org overrides** resolved at request time, sliding/moving window. Model: Langfuse `getRateLimitConfig() = override || planDefault`.

**1.2 Real-time quota counter.** Replace the hourly `ingestion_blocked` flag with a Redis counter incremented at ingest (or at queue-time) so free-tier overshoot shrinks from ~1h to near-real-time; make the billing worker parallel across workspaces (currently O(workspaces) sequential). Files: `frontend/worker/src/ee/billing/usageMetering.ts:54-86,298-306`.

**1.3 ClickHouse durability + read/write split.** Move to `ReplicatedReplacingMergeTree` + Keeper with ≥1 replica for durability; route dashboard reads to a **read replica/endpoint** (Langfuse `CLICKHOUSE_READ_ONLY_URL`) so reads don't contend with ingestion inserts. (Sharding can stay deferred — even Langfuse is single-shard + vertical.)

**1.4 Split ingestion vs dashboard API + autoscale.** Separate FastAPI deployments for `/public/traces*` (ingestion) vs dashboard/read APIs so ingestion bursts can't slow the UI (Langfuse's documented split). Add **HPA** keyed on CPU and/or queue depth (everything is 1 replica with no autoscaling today).

### Tier 2 — Read path & efficiency at volume

**2.1 Kill `FINAL` on the hot paths.** Remove the **read-before-write `SELECT ... FROM traces FINAL`** on ingest (`ingest_tasks.py:121-126`). For dashboard reads, prefer `ORDER BY ts LIMIT 1 BY id` over `FINAL`, and for immutable OTel spans skip dedup entirely (Langfuse `LANGFUSE_SKIP_FINAL_FOR_OTEL_PROJECTS`).
**2.2 Time-pruning-first read contract.** Require a time filter on list/metrics endpoints, use **keyset (token) pagination** not OFFSET, ensure ORDER BY leads with `(project_id, toDate(time), id)` (already close).
**2.3 Skinny MV for dashboards.** Materialized view that truncates large `input/output/metadata` into a slim table for list/dashboard queries; hit the full table only for single-record detail (`parallel_view_processing=1`). Gave Langfuse 10–20×.
**2.4 Worker hygiene.** Bound `worker_concurrency`/prefetch, add task time limits, **separate queues** for ingest vs detector (one slow consumer shouldn't stall all), and a **psycopg2 connection pool** for the detector (currently connects per task — `detector_tasks.py:106`).
**2.5 SDK durability.** Raise `maxQueueSize` default above 2048 and consider a persistent/disk buffer so sustained backpressure degrades to lag, not span loss.

---

## The one-paragraph synthesis

Traceroot picked the correct ingestion *shape* early (async S3 + queue) — that's the expensive architectural decision and it's already right. The maturity gap vs. Langfuse/SigNoz/Opik is almost entirely in **flow control and the ClickHouse write discipline**: aggregate inserts across requests (+async_insert) to avoid part explosion, bound the queue and answer overload with `429/Retry-After` so OTel clients back off instead of dropping, make ingest non-blocking, and give ClickHouse a replica + a read endpoint. Tiered limits, real-time quota, API splitting, and the read-path/`FINAL` work are the next layer once the foundation holds. None of this requires abandoning the current stack.

### Key sources
Langfuse: v3 infra blog, 2026 "Simplify for Scale" blog, self-hosting/scaling docs, `ClickhouseWriter/index.ts`, `RateLimitService.ts`. SigNoz: collector config (batch 10k/10s, memory_limiter, sending_queue), Kafka burst-handling wiki. Opik: architecture blog (async_insert=1, ReplacingMergeTree, UUIDv7). Phoenix: `app.py` BulkInserter + CapacityInterceptor. OTLP: spec + OTel SDK BatchSpanProcessor defaults + retry contract.

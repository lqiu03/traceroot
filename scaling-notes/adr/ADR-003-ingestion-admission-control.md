# ADR-003: Ingestion admission control + bounded queue + DLQ

- Status: Proposed (admission-control prototyped + load-tested; DLQ/queue-split not yet)
- Date: 2026-05-22
- Context source: `scaling-notes/traceroot-loadtest-results.md` ("P1 demonstrated end-to-end")

## Context

The ingest endpoint writes the event to S3 and enqueues a Celery task
(`process_s3_traces.delay`) to a **single, unbounded Redis-backed queue**, then always
returns `200`. There is **no backpressure**: if the worker tier can't keep up, the queue
grows without limit. Enqueue failures are also **swallowed** ("S3 has the data") with no
reconciliation, so a Redis outage silently drops traces from ClickHouse.

Demonstrated by throttling the worker to `--concurrency 1` under a conc=40 load: the queue
grew **linearly and unbounded** (0 → 979 tasks in 65 s) while REST returned `200` for
every request. In production this path leads to **Redis OOM** and ever-staler data, then
silent loss.

Separately, the **detector fan-out** (`enqueue_detector_runs`) shares the same `celery`
queue, so detector load competes with ingestion and inflates the same backlog.

## Decision

1. **Admission control:** before accepting work, check queue depth (`LLEN celery`); above a
   high-water mark return **`429 + Retry-After`** (OTLP exporters honor it and back off).
   Make the threshold configurable; optionally scope per-tenant.
2. **Separate queues:** route ingestion and detector tasks to **distinct Celery queues** so
   detector work can't starve ingestion (and the high-water reflects ingestion backlog only).
3. **Durability:** add a **dead-letter queue** for terminal task failures and an
   **orphan-S3 reconciliation** sweeper so swallowed enqueue failures / Redis blips don't
   lose data (the S3 object already exists and is replayable).
4. Pair with worker-tier scaling (replicas/concurrency) — admission control caps the
   backlog; scaling raises drain capacity. The two are complementary.

## Consequences

- Measured effect of (1) on the spike (same concurrency-1 overload): backlog **stabilized
  at ~500** instead of running away; **889 accepted / 1,091 shed** via `429+Retry-After`.
  Bounded load-shedding instead of unbounded failure; shed load becomes client backoff,
  not data loss.
- `429` on the ingestion path must be in the SDK's retryable set (OTLP: it is) and carry a
  sane `Retry-After` (≤ ~60 s) so exporters back off without dropping their batch.
- A high-water that's too low throttles legitimate bursts; tune against worker drain rate.

## Alternatives considered

- Bounded broker / queue max-length that rejects at enqueue: blunter, gives the client no
  clean signal; admission-control-with-429 is friendlier to OTLP exporters.
- Only scale workers (no admission control): moves the breaking point but still unbounded
  under sufficient load; defense-in-depth wants both.

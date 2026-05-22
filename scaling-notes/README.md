# Ingestion scaling spike — WIP (DO NOT MERGE)

Throwaway exploration branch off `main`. Captures a measured investigation into Traceroot's
ingestion scaling, plus a load-test harness and prototype fixes. **Not production-ready; not for merge.**
Resume point for continuing on another machine.

## What's in this branch

### Prototype code changes (scratch spikes, on top of `main`)
Four files, all reversible. Each is a measured experiment, not a finished change:

1. `backend/rest/routers/public/traces.py`
   - `import asyncio`; offload blocking S3 `upload_json` via `asyncio.to_thread`; run `head_bucket` once per process (`_ensure_bucket_once`).
   - Redis-cache API-key validation (`_get_auth_redis`, `authcache:` keys, TTL 30s) to skip the per-request web+Postgres round-trip.
   - **Admission control (P1):** `LLEN celery`; if backlog > `_QUEUE_HIGH_WATER` (500) return `429 + Retry-After` before doing work — bounded load-shedding instead of an unbounded queue.
2. `docker/Dockerfile.rest` — `uvicorn ... --workers 4` (was a single worker).
3. `backend/db/clickhouse/client.py` — `async_insert=1, wait_for_async_insert=1` on both inserts.
4. `backend/worker/ingest_tasks.py` — drop `FINAL` from the read-before-write existence check.

### Forward plan
- `PLAN.md` — phased delivery plan (Phase 1 ship validated hot-path fixes → Phase 2 durability/fairness → Phase 3 scale-out infra → Phase 4 efficiency-at-volume), with effort, DoD, and decisions needed.

### Analysis (the bulk of the thinking)
- `traceroot-scaling-assessment.md` — architecture map vs Langfuse/SigNoz/Opik/Phoenix, gap matrix, OTLP contract, tiered roadmap.
- `traceroot-loadtest-results.md` — **the load-test results**: baseline → P0 → auth-cache → worker/CH, with before/after RPS, p99, CPU tables, and the bottleneck-migration narrative.
- `pr-565-review-draft.md` + `pr-565-proposed-adjustments.md` — review + patches for the open rate-limiting PR #565 (verdict: request changes; Greptile's headline finding is a false positive).
- `adr/` — Architecture Decision Records distilled from the measured evidence: ADR-001 (REST concurrency + non-blocking I/O), ADR-002 (auth-validation caching), ADR-003 (admission control + bounded queue + DLQ).
- `loadtest/loadgen.py` + `loadtest/poller.sh` — the reusable harness (OTLP/protobuf, host external client + metrics poller).
- `loadtest/metrics_before.csv` / `metrics_after.csv` — sampled queue depth + ClickHouse parts/rows.

## Key measured findings (so the next session starts from evidence)
- **Binding constraint = REST ingestion ~10 RPS**, serialized by a single uvicorn worker + blocking boto3 (Little's Law: flat throughput, p99 640ms→25.9s as conc 2→80).
- Fixing it (multi-worker + non-blocking S3) ~2x'd throughput; bottleneck moved to **per-request auth round-trip** (web 100%, postgres 112%).
- Redis-caching auth validation dropped **web CPU 100%→0%**; bottleneck moved to **worker→ClickHouse**.
- ClickHouse "too many parts" is **NOT** an imminent risk at current scale (`parts_to_throw_insert=3000`; 400 small inserts → 4 parts). `async_insert`/`FINAL` removal are scale-gated (correct, but no measurable gain on a dev laptop).
- Absolute RPS is compressed because all tiers are co-located on one dev laptop (~8–10 shared cores). The reproducible result is the **migration of the hot tier** down the stack with each fix.
- **P1 (unbounded queue) demonstrated + fixed:** with the worker throttled to concurrency 1, the queue grew unbounded while REST returned 200 for everything (no backpressure). Adding admission control (`429+Retry-After` above a 500-task high-water) made the backlog **stabilize at ~500** (889 accepted / 1,091 shed) instead of running away. See the "P1 demonstrated end-to-end" section of `traceroot-loadtest-results.md` and `loadtest/metrics_backlog.csv` (failure) vs `metrics_backpressure.csv` (fixed).
- Also observed live: the **free-plan 50k-event quota** flipped `ingestion_blocked` via the hourly billing job mid-test → ingestion returned 402 (roadmap L3, eventually-consistent quota).

## How to resume / re-run the load test
1. Bring up the stack (`make prod-lite`, or `docker compose -f docker-compose.prod.yml up --build`).
2. Mint a throwaway key in Postgres (workspace→project→access_key; `secret_hash = sha256(plaintext)`).
   The harness defaults to key `lt_loadtest_0001`.
3. `python -m venv venv && venv/.../pip install httpx opentelemetry-proto`
4. Ramp: `python loadtest/loadgen.py --mode ramp --spans 20 --stages 2,5,10,20,40,80 --stage-seconds 20`
   Poller (separate shell): `bash loadtest/poller.sh`

## Suggested next step (where the spike series stopped)
P0 (REST concurrency + non-blocking I/O), 0.3b (auth cache), P2 (async_insert/FINAL, scale-gated), and
**P1 (admission control / backpressure)** are all now prototyped and measured. Remaining high-value items:
- **Separate Celery queues** for ingest vs detector (the detector fan-out shares the `celery` queue today,
  so detector load can starve ingestion and inflate the backlog the high-water sees).
- **DLQ + orphan-S3 reconciliation** for the enqueue-failure path (currently swallowed → silent loss on Redis OOM).
- **Plan/org-tiered rate limits** (evolve PR #565; per-resource buckets, per-org override, moving-window).
- **Cleaner-isolation re-measure**: per-container CPU limits + worker replicas (and/or millions of seeded
  rows) to show the worker-path / independent-tier scaling that a co-located laptop can't.
- Productionize the backpressure prototype: configurable high-water, per-tenant option, metrics on shed rate.

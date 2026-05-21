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
2. `docker/Dockerfile.rest` — `uvicorn ... --workers 4` (was a single worker).
3. `backend/db/clickhouse/client.py` — `async_insert=1, wait_for_async_insert=1` on both inserts.
4. `backend/worker/ingest_tasks.py` — drop `FINAL` from the read-before-write existence check.

### Analysis (the bulk of the thinking)
- `traceroot-scaling-assessment.md` — architecture map vs Langfuse/SigNoz/Opik/Phoenix, gap matrix, OTLP contract, tiered roadmap.
- `traceroot-loadtest-results.md` — **the load-test results**: baseline → P0 → auth-cache → worker/CH, with before/after RPS, p99, CPU tables, and the bottleneck-migration narrative.
- `pr-565-review-draft.md` + `pr-565-proposed-adjustments.md` — review + patches for the open rate-limiting PR #565 (verdict: request changes; Greptile's headline finding is a false positive).
- `loadtest/loadgen.py` + `loadtest/poller.sh` — the reusable harness (OTLP/protobuf, host external client + metrics poller).
- `loadtest/metrics_before.csv` / `metrics_after.csv` — sampled queue depth + ClickHouse parts/rows.

## Key measured findings (so the next session starts from evidence)
- **Binding constraint = REST ingestion ~10 RPS**, serialized by a single uvicorn worker + blocking boto3 (Little's Law: flat throughput, p99 640ms→25.9s as conc 2→80).
- Fixing it (multi-worker + non-blocking S3) ~2x'd throughput; bottleneck moved to **per-request auth round-trip** (web 100%, postgres 112%).
- Redis-caching auth validation dropped **web CPU 100%→0%**; bottleneck moved to **worker→ClickHouse**.
- ClickHouse "too many parts" is **NOT** an imminent risk at current scale (`parts_to_throw_insert=3000`; 400 small inserts → 4 parts). `async_insert`/`FINAL` removal are scale-gated (correct, but no measurable gain on a dev laptop).
- Absolute RPS is compressed because all tiers are co-located on one dev laptop (~8–10 shared cores). The reproducible result is the **migration of the hot tier** down the stack with each fix.

## How to resume / re-run the load test
1. Bring up the stack (`make prod-lite`, or `docker compose -f docker-compose.prod.yml up --build`).
2. Mint a throwaway key in Postgres (workspace→project→access_key; `secret_hash = sha256(plaintext)`).
   The harness defaults to key `lt_loadtest_0001`.
3. `python -m venv venv && venv/.../pip install httpx opentelemetry-proto`
4. Ramp: `python loadtest/loadgen.py --mode ramp --spans 20 --stages 2,5,10,20,40,80 --stage-seconds 20`
   Poller (separate shell): `bash loadtest/poller.sh`

## Suggested next step (where the spike series stopped)
The hot tier is now **worker → ClickHouse**. To measure the worker-path fixes properly, the dev laptop
needs per-container CPU limits + worker replicas (and/or millions of seeded rows). Otherwise the next
high-value, production-relevant items are: bounded queue + backpressure (429/Retry-After) + DLQ,
separate Celery queues for ingest vs detector, and plan/org-tiered rate limits (evolving PR #565).

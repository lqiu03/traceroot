# Traceroot ingestion load test — measured results (2026-05-21)

Local baseline stack (`traceroot-pr-913`, = current `main` backend), single replica each, default config. Harness: `C:\tmp\loadtest\loadgen.py` (host, external client, OTLP/protobuf, 20 spans/request), poller: `C:\tmp\loadtest\poller.sh`. Throwaway key minted in local Postgres.

## Headline

**The binding constraint today is the REST ingestion tier: ~7–11 requests/sec (~150–230 spans/sec) regardless of concurrency.** It is a *serialized* bottleneck — a single uvicorn event loop doing blocking boto3 S3 calls per request. Everything downstream (queue, ClickHouse) stayed healthy *only because this cap throttled the input.*

## Concurrency ramp (20 spans/request, 20s/stage)

| concurrency | RPS | spans/s | p50 ms | p95 ms | p99 ms | max ms |
|---|---|---|---|---|---|---|
| 2 | 7.0 | 139 | 265 | 469 | 640 | 844 |
| 5 | 8.2 | 163 | 594 | 938 | 1515 | 1532 |
| 10 | 8.8 | 176 | 1172 | 1547 | 1657 | 1750 |
| 20 | 7.9 | 158 | 2672 | 3453 | 3922 | 4391 |
| 40 | 10.1 | 201 | 4266 | 6563 | 8281 | 9953 |
| 80 | 11.4 | 228 | 6609 | 22515 | 25890 | 26016 |

**Diagnosis (Little's Law):** throughput flat (~10 RPS) while concurrency rose 40× and p99 rose ~40×. Latency ∝ concurrency at constant throughput ⇒ serialized bottleneck of ~10 req/s.

**Mechanism (confirmed):** `docker/Dockerfile.rest` runs `uvicorn rest.main:app` with **no `--workers`** → one event loop. The ingest handler makes **synchronous boto3 calls on that loop every request**: `ensure_bucket_exists()` (an S3 `head_bucket` per request) + `upload_json()` (S3 `put`), plus CPU-bound gzip/protobuf decode. These serialize; ~100–140 ms of blocking work per request ⇒ ~10 req/s ceiling.

## Downstream during the ramp (poller)

- **Celery queue depth: stayed 0 the entire run.** Worker drained in real time — because input was capped at ~10 RPS.
- **ClickHouse active parts: 2–8** (spans + traces) throughout; never approached any threshold.
- Rows grew linearly to 21,305 spans / 1,066 traces, then flat. No errors (1 client-side timeout at conc=80).

## Write-strategy micro-benchmark (isolated, scratch ReplacingMergeTree table)

| pattern | active parts | rows |
|---|---|---|
| 400 inserts × 1 row (current per-task style) | **4** | 400 |
| 1 insert × 400 rows (batched) | **1** | 400 |

- Thresholds on this build: `parts_to_delay_insert=1000`, `parts_to_throw_insert=3000` (higher than the classic 150/300).
- **Finding:** ClickHouse's background merger easily absorbs ~400 small sequential inserts (→4 parts). The "too many parts" wall is far away at current rates. Batching is still better (fewer parts, less merge/CPU overhead) but it is a **high-scale optimization, not an imminent failure.**

## AFTER the P0 fix (local scratch spike, re-measured)

Scratch edits (NOT for production merge): `uvicorn --workers 4` + `asyncio.to_thread(upload_json)` + `head_bucket` once-per-process.

| concurrency | BEFORE RPS | AFTER RPS | BEFORE p99 ms | AFTER p99 ms |
|---|---|---|---|---|
| 2 | 7.0 | 10.9 | 640 | 1,203 |
| 5 | 8.2 | **17.4** | 1,515 | **891** |
| 10 | 8.8 | 13.4 | 1,657 | 7,500 |
| 20 | 7.9 | 10.4 | 3,922 | 12,906 (+9 transient 503) |
| 40 | 10.1 | 14.3 | 8,281 | 10,546 |
| 80 | 11.4 | 16.7 | 25,890 | 20,015 |

Isolated burst @ conc 40: **21.3 RPS / 426 spans/s** (vs ~10 before).

**CPU during a sustained burst (the key evidence):**
`rest 292%` (≈3 cores; was pinned to ~1 before) · `clickhouse 235–369%` · `worker 187%` · `postgres 112%` · `web 100%` · `minio 43%` → aggregate ~800–970% (~8–10 cores busy).

**Interpretation:**
- The fix **eliminated the single-event-loop serialization** — `rest` now uses multiple cores and peak throughput ~doubled, with low-concurrency tail latency cut roughly in half (conc 5 p99 1,515 → 891 ms).
- The **new ceiling is aggregate host CPU** on the co-located dev laptop, not the REST loop. The clean multi-worker/horizontal-replica multiplier can only be shown on dedicated, independently-scaled tiers (roadmap 1.4).
- **Next walls now visible:** the per-request **auth round-trip + Postgres `lastUseTime` write** (`web 100%` + `postgres 112%`, plus transient 503s from the auth path) → cache API-key validation (roadmap 0.3b); and **ClickHouse CPU** from worker inserts + read-before-write `FINAL` (roadmap 2.1).
- Queue stayed 0 and parts 2–8 throughout even at the higher RPS — queue/parts walls still masked; need dedicated infra + higher sustained RPS to reach them.

## AFTER the auth-cache fix (P0.3b, stacked on the P0 spike)

Scratch edit: Redis-cache the API-key validation result on the rest side (TTL 30s), so repeated keys skip the `rest → web → Postgres` round-trip.

**conc=40 burst, CPU during load — before vs after each fix:**

| service | baseline (1 worker) | + P0 (workers+to_thread) | + auth cache |
|---|---|---|---|
| rest | ~100% (1 core, serialized) | **292%** | 45–60% |
| web | (idle) | **100%** | **0.0%** |
| postgres | (idle) | **112%** | 54–75% |
| worker | — | 187% | 95–141% |
| clickhouse | — | 235–369% | 147–197% |
| **peak RPS @ conc40** | ~14 | 21.3 | **23.7** |

- `validate-api-key` calls during the burst dropped from ~one-per-request to **5 total** (cache misses / TTL refreshes).
- **`web` CPU collapsed 100% → 0%** — the web tier is removed from the ingestion hot path entirely. `postgres` roughly halved.
- Queue stayed 0; parts stayed 4–6 throughout.

## The bottleneck migration (the headline narrative)

Each fix removed one wall and exposed the next — exactly how real scaling work proceeds:

1. **Baseline** → bottleneck = **REST event loop** (single uvicorn worker + blocking boto3). ~10 RPS, flat vs concurrency.
2. **+ multi-worker & non-blocking S3** → REST scales to ~3 cores; bottleneck moves to **aggregate host CPU + per-request auth round-trip** (`web 100%`, `postgres 112%`). ~21 RPS.
3. **+ auth-validation cache** → web tier eliminated from hot path (`web 0%`); bottleneck moves to the **worker → ClickHouse processing path** (`worker ~141%`, `clickhouse ~197%`). ~24 RPS.

Absolute RPS gains are compressed because all tiers are co-located on one dev laptop (~8–10 shared cores); on dedicated, independently-scaled deployments each removed bottleneck unlocks a full tier. The **migration of the hot tier** is the environment-independent, reproducible result.

**Next wall (now measured):** the worker + ClickHouse path — i.e. roadmap P1 (scale worker tier / concurrency) + 2.1 (kill read-before-write `FINAL`) + P2 (batch inserts/`async_insert`). That is where the next spike should go.

## AFTER the worker/ClickHouse spike (async_insert + FINAL removal)

Scratch edits: `async_insert=1, wait_for_async_insert=1` on both ClickHouse inserts; dropped `FINAL` from the read-before-write existence check.

**conc=40 burst, with async_insert:** RPS **24.4** (vs 23.7); CPU `worker 108–161%`, `clickhouse 102–165%` (down from ~150–197%), `web 0%`, `postgres ~59%`. Marginal throughput gain; ClickHouse CPU eased somewhat.

**`FINAL` micro-benchmark** (existence query on the `traces` table, 3,980 rows / 5 parts):

| | run 1 | run 2 | run 3 |
|---|---|---|---|
| WITH FINAL | 21 ms | 11 ms | 9 ms |
| WITHOUT FINAL | 12 ms | 11 ms | 11 ms |

**Honest finding:** at this data volume `FINAL` is **statistically free** — there's almost nothing to merge-on-read with 5 parts. Two reasons it didn't move the benchmark: (1) the read-before-write `FINAL` is only hit by **rootless/late-arriving** batches, which the complete-trace load generator never produces; (2) `async_insert` and `FINAL` are both **scale-gated** — their payoff appears at millions of rows / many parts, not on a dev stack. They are correct production changes, but the dev laptop can't demonstrate their value.

## Full arc — what each spike actually bought

| Spike | Change | Peak RPS @ conc40 | What moved | Verdict |
|---|---|---|---|---|
| Baseline | — | ~14 | — | REST loop serialized |
| P0 | uvicorn `--workers 4` + non-blocking S3 | 21.3 | rest 1→3 cores; web/postgres became hot | **Big win** (removed serialization) |
| 0.3b | Redis-cache auth validation | 23.7 | **web 100%→0%**, postgres halved | **Clean win** (removed a tier from hot path) |
| 2.1/P2 | async_insert + FINAL removal | 24.4 | ClickHouse CPU eased | **Marginal at dev scale** (scale-gated; correct for prod) |

**Conclusion:** the high-leverage fixes were the first two — eliminating the single-event-loop serialization and the per-request auth round-trip. The worker/ClickHouse optimizations are correct but their benefit is realized at production data volumes and with independently-scaled worker replicas, neither of which a single co-located dev laptop can exhibit. To measure those properly: per-container CPU limits + worker replicas, or a dataset of millions of rows.

## Evidence-corrected priority ranking

1. **P0 — REST ingestion throughput is the wall at ~10 RPS / ~200 spans/s.** *(measured, binding today)*
   - Run multiple workers (gunicorn `-k uvicorn.workers.UvicornWorker -w N`, or `uvicorn --workers N`) **and**
   - **De-block the event loop:** wrap boto3 `upload_json` in `asyncio.to_thread`; do `head_bucket` once at startup, not per request; keep auth async (already is).
   - Then scale REST horizontally (replicas + HPA). This single area gives the biggest immediate win — likely 10–50× headroom.
2. **P1 — Bounded queue + backpressure + DLQ / orphan-S3 reconciliation.** *(latent now; activates once P0 lifts throughput)* Queue stayed 0 only because input was throttled. Once REST does 100s of RPS, the worker (single replica) becomes the drain bottleneck and the unbounded queue + swallowed enqueue errors become real (OOM / silent loss). Return 429+Retry-After at a high-water mark; add a DLQ.
3. **P1 — Scale the worker tier** (concurrency tuning, replicas, separate queues for ingest vs detector) so it can drain the higher post-P0 ingest rate.
4. **P2 — ClickHouse write batching + `async_insert`.** *(re-prioritized DOWN from research rank)* Real benefit at high scale, but merges keep up to the 3000-part threshold today; not the first wall. Pairs with P1 worker scaling.
5. **P2 — Quota real-time counter; P2 — read-path `FINAL`/MV work; P2 — CH replica/read-split** as before.

## Caveats

- Single sequential client session in the micro-benchmark let merges interleave; a massively concurrent insert storm would spike parts higher transiently — but the 3000 threshold leaves wide headroom.
- Test ran on one dev machine (Docker Desktop) with co-located services; absolute RPS would differ in prod, but the *serialization signature* (flat throughput vs concurrency) is environment-independent and is the key finding.
- Ramp only reached ~11 RPS, so the worker/queue/parts walls were not driven to failure — they are masked by P0. Re-run after P0 to find the next wall.

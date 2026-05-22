# Traceroot scaling — forward plan

From "needs validated" (this branch) to "production-grade scaling shipped." Grounded in the
measured findings (`traceroot-loadtest-results.md`) and decisions (`adr/`). Ordering principle:
**correctness/availability → throughput → efficiency-at-scale**, measuring at each step, and
applying the two-lever model (admission control bounds backlog; tier replicas raise capacity).

Effort: S ≈ <1 day, M ≈ 1–3 days, L ≈ >3 days / infra. Each item lists a Definition of Done (DoD).

---

## Phase 0 — DONE (this branch)
Research + competitor benchmark, architecture assessment, 4-stage measured load test, P1
demonstrated + fixed, worker-scaling validated, 3 ADRs, reusable harness. Prototypes live on
`spike/ingestion-scaling-loadtest` (not merged).

## Phase 1 — Ship the validated hot-path fixes (highest ROI, low risk) — DO FIRST
Turn the proven spike edits into real PRs **with tests**. Each was measured on this branch.

- **PR-A · REST ingestion concurrency + non-blocking I/O** (ADR-001). Multi-worker
  (`gunicorn -k uvicorn.workers.UvicornWorker -w N`), `asyncio.to_thread` for boto3, hoist
  `head_bucket` to startup. Effort S. DoD: loadgen ramp shows throughput scaling with
  concurrency (not flat); ingest still 200; worker-count configurable via env.
- **PR-B · Cache API-key validation + drop per-request `lastUseTime`** (ADR-002). Redis
  cache (short TTL), throttle/async the `lastUseTime` write. Effort S–M. Risk: revocation
  consistency. DoD: web/Postgres CPU drop under load; revoked key rejected within TTL; tests
  for hit/miss/expiry.
- **PR-C · Ingestion admission control** (ADR-003 §1). `LLEN` high-water → `429 + Retry-After`,
  threshold configurable. Effort S. DoD: backlog bounded under overload; 429 carries
  Retry-After; SDK backs off (OTLP integration test); metric for shed rate.

## Phase 2 — Durability & fairness (correctness — don't lose data, no noisy neighbors)
- **PR-D · Separate Celery queues** ingest vs detector (routing + per-queue concurrency).
  Effort M. DoD: detector load can't grow the ingest backlog; routing test.
- **PR-E · DLQ + orphan-S3 reconciliation** (ADR-003 §3). Stop swallowing enqueue failures;
  periodic sweeper re-enqueues S3 objects with no ClickHouse record; terminal failures → DLQ.
  Effort M. Risk: correctness-critical. DoD: simulated Redis outage loses 0 traces;
  poison task lands in DLQ, not infinite retry.
- **PR-F · Plan/org-tiered rate limits** — evolve PR #565 (per-resource buckets, per-org
  override resolved from validated auth, moving-window; raise ingestion default; the
  `enabled` flag already works). Effort M. DoD: limits vary by plan + override; 429 contract;
  tests. (See `pr-565-review-draft.md` / `pr-565-proposed-adjustments.md`.)

## Phase 3 — Real-time quota + scale-out infra
- **PR-G · Real-time usage counter** (Redis) augmenting the hourly `ingestion_blocked` flag;
  parallelize the O(workspaces) billing job. Effort M. DoD: free-tier overshoot window drops
  from ~1h to near-real-time; billing job runtime sub-linear in tenant count.
- **INFRA-H · Independent tiers + autoscaling** (ADR-001 §3). Split ingestion vs dashboard API
  into separate deployments; HPA on CPU/queue-depth for REST + worker. Effort M (helm). DoD:
  ingestion bursts don't degrade UI latency; pods scale on queue depth.
- **INFRA-I · ClickHouse durability + read/write split.** `ReplicatedReplacingMergeTree` +
  Keeper + ≥1 replica; route dashboard reads to a read endpoint. Effort L. Risk: stateful
  migration. DoD: node loss doesn't lose data; reads don't contend with ingestion inserts.

## Phase 4 — Efficiency at volume (scale-gated — do when data volume warrants)
Measurements showed these are NOT urgent at current scale (3000-part wall; FINAL ≈ free at
small volume), so schedule them by data growth, not now.
- **PR-J · ClickHouse write batching/accumulator + `async_insert` + `insert_deduplicate`**
  (idempotent client retries). Effort M.
- **PR-K · Read-path:** require time filters + keyset pagination; skip `FINAL` for immutable
  OTel spans (or `LIMIT 1 BY id`); drop read-before-write `FINAL`. Effort M.
- **PR-L · Skinny materialized view** for dashboards (truncate large input/output/metadata).
  Effort M–L.

## Cross-cutting — validation environment (unblocks Phase 3/4 proof)
The dev laptop is host-CPU-bound (~8–10 shared cores) and can't show tier scaling or the
scale-gated fixes. Stand up a **dedicated load environment** (separate nodes / CPU limits per
tier, millions of seeded rows) and reuse `loadtest/`. Add observability: queue-depth metric,
shed-rate counter, ClickHouse parts/merge metrics. Re-run the harness after each phase to
confirm the bottleneck moved as predicted.

## Decisions needed (team/owner input)
1. Ship Phase 1 as PRs now? (Recommended — measured, low-risk, immediate wins.)
2. PR #565: amend-with-changes vs supersede with the tiered version (PR-F)?
3. ClickHouse replication (INFRA-I): cost/timing — biggest infra commitment.
4. Sequencing: Phase 1 → 2 first (correctness + throughput), Phase 3 when traffic warrants,
   Phase 4 gated on data volume.

## Suggested first sprint
PR-A, PR-B, PR-C (Phase 1, all measured + low-risk) + PR-E (data-loss fix) — ship the wins and
close the silent-loss gap, then re-measure on the dedicated environment before Phase 3 infra.

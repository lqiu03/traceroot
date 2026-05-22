# HANDOFF — Traceroot scaling investigation (for the next agent)

**Status (2026-05-22):** research + a measurement-driven validation are **complete**; the
project **direction is NOT yet decided** by the owner. Nothing is merged. Everything below
lives on branch `spike/ingestion-scaling-loadtest` (fork `lqiu03/traceroot`, based off `main`,
**WIP / do-not-merge**). No PR opened. This document is the entry point for picking the work up
cold; start here, then read `README.md` (file index) and `PLAN.md` (forward plan).

---

## 1. Project context
Traceroot.ai is an LLM/agent **observability platform** (OTLP traces). Stack:
- `rest` — FastAPI, public OTLP ingestion + dashboard read APIs (Python).
- `worker` — Celery; transforms S3 events → ClickHouse; fans out detector runs; publishes live spans.
- `web` — Next.js (UI + internal auth/validate-api-key; owns Postgres via Prisma).
- Data: **ClickHouse** (traces/spans, `ReplacingMergeTree`), **Postgres** (workspaces/projects/keys/billing),
  **Redis** (Celery broker + live pub/sub), **S3/MinIO** (raw OTLP event store).
- SDK: TypeScript (`traceroot-sdk-ts`), stock OTel `BatchSpanProcessor` + OTLP/proto exporter.
- Ingestion shape (already good): endpoint writes event to S3 → `process_s3_traces.delay()` → returns fast.

## 2. The goal (as given)
"Explore fundamental needs in scaling Traceroot.ai." Began at PR #565 (basic rate limiting),
broadened into a full ingestion-scaling investigation benchmarked against competitors.

## 3. What was done
1. **PR #565 review** (rate limiting). Verdict: **request changes** (tests missing; ingestion
   limit too low; slowapi sync-Redis; fixed-window burst; scope creep). **Greptile's headline
   finding is a FALSE POSITIVE** — the `enabled` flag *is* wired. Drafts: `pr-565-review-draft.md`,
   `pr-565-proposed-adjustments.md`. Not posted (owner posts manually).
2. **Competitor research** (primary sources): Langfuse (primary), SigNoz, Opik, Arize Phoenix,
   OTLP spec. → `traceroot-scaling-assessment.md` (gap matrix + roadmap).
3. **Load-test campaign** on the live local stack (harness in `loadtest/`). Measured each fix
   and watched the bottleneck migrate down the stack. → `traceroot-loadtest-results.md`.
4. **Decisions + plan**: `adr/ADR-001..003`, `PLAN.md`.

## 4. Key findings (the durable knowledge)
- **Binding constraint was REST ingestion ~10 RPS**, serialized (single uvicorn worker + blocking
  boto3 on the event loop). Little's Law: flat throughput, p99 640ms→25.9s as conc 2→80.
- **Bottleneck migration with each fix:** REST loop → (multi-worker + non-blocking S3, ~2×) →
  per-request auth round-trip (web 100% / pg 112%) → (Redis-cache auth, **web→0%**) →
  worker/ClickHouse.
- **Two-lever conclusion for ingestion:** *admission control* bounds the backlog
  (`429+Retry-After`), *worker replicas* raise drain capacity. Measured together: 1→3 drain slots
  cut shed from 1091→100 while the queue stayed bounded.
- **Unbounded-queue / no-backpressure is a real failure mode** (demonstrated: queue 0→979, all 200s)
  → fixed with admission control (backlog flatlined at the 500 high-water).
- **ClickHouse "too many parts" is NOT urgent** at current scale (`parts_to_throw_insert=3000`;
  400 small inserts → 4 parts). `async_insert`/`FINAL` removal are **scale-gated** (correct, no
  measurable gain on a dev laptop). This *inverts* the research ranking — the methodological
  lesson: **measure before/while optimizing.**
- **Live finding:** free-plan **50k-event quota** flipped `ingestion_blocked` via the hourly billing
  job mid-test → 402 (roadmap L3: eventually-consistent quota; billing job is O(workspaces) sequential).
- **Caveat:** all numbers are from one co-located dev laptop (~8–10 shared cores); absolute RPS is
  compressed and tier-scaling can't be shown here. The *shapes* and the *bottleneck migration* are
  the environment-independent results.

## 5. Artifact map (in `scaling-notes/`)
- `HANDOFF.md` (this) · `README.md` (file index + resume) · `PLAN.md` (phased forward plan).
- `traceroot-scaling-assessment.md` — architecture vs competitors, gap matrix, roadmap.
- `traceroot-loadtest-results.md` — full measured arc (baseline→P0→auth→P2→P1→worker-scaling).
- `adr/ADR-001..003` — REST concurrency, auth caching, admission control (cite the numbers).
- `pr-565-review-draft.md` + `pr-565-proposed-adjustments.md` — the rate-limiting PR.
- `loadtest/loadgen.py` + `poller.sh` — reusable harness; `metrics_*.csv` — raw evidence
  (force-added past a blanket `*.csv` gitignore — remember `git add -f` for new CSVs).

## 6. Prototype edits on this branch (spikes, NOT PRs)
All measured; each is a candidate Phase-1/2 PR (see `PLAN.md`). Reversible (`git checkout .`).
- `backend/rest/routers/public/traces.py`: `asyncio.to_thread` for S3 + `head_bucket` once;
  Redis-cached API-key validation (TTL 30s); **admission control** (`LLEN celery`>500 → 429+Retry-After).
- `docker/Dockerfile.rest`: `uvicorn --workers 4`.
- `backend/db/clickhouse/client.py`: `async_insert=1, wait_for_async_insert=1`.
- `backend/worker/ingest_tasks.py`: drop `FINAL` from the read-before-write existence check.

## 7. How to resume (local)
1. Clone/checkout: `git fetch && git checkout spike/ingestion-scaling-loadtest`.
2. Bring up stack: `make prod-lite` (or `docker compose -f docker-compose.prod.yml up --build`); UI :3000, rest :8000.
3. Mint a throwaway key in Postgres (`workspaces`→`projects`→`access_keys`; `secret_hash = sha256(plaintext)`).
   Harness default key: `lt_loadtest_0001`. **Gotcha:** the free-plan 50k-event cap will flip
   `ingestion_blocked` via the hourly billing job — set the test workspace `billing_plan='pro'` to avoid 402s.
4. `python -m venv venv` → `pip install httpx opentelemetry-proto`.
5. Ramp: `python loadtest/loadgen.py --mode ramp --spans 20 --stages 2,5,10,20,40,80 --stage-seconds 20`;
   poller (separate shell): `bash loadtest/poller.sh <output.csv>`.

## 8. THE OPEN DECISION (owner has not chosen direction)
Pick a path; the plan is sequenced but not started. From `PLAN.md`:
1. Ship Phase-1 measured fixes (PR-A REST concurrency, PR-B auth cache, PR-C admission control) as real PRs now? (Recommended — measured, low-risk.)
2. PR #565: amend-with-changes vs supersede with the tiered-limits version (PR-F)?
3. ClickHouse replication (INFRA-I) timing/cost — the biggest infra commitment.
4. Phase ordering: correctness+throughput first (Phases 1–2), scale-out (3) when traffic warrants, efficiency (4) gated on data volume.
The one item that should NOT wait for a direction call: **PR-E (DLQ + orphan-S3 reconciliation)** —
swallowed enqueue failures are a silent-data-loss bug today, independent of traffic.

## 9. Open research questions (where more allocation would deepen understanding)
Not yet investigated / unproven; flagged for the owner's offer of more research blocks:
- **Read/query-path scaling** — dashboard query latency at volume is assessed from code but **not load-tested**.
- **Detector / RCA pipeline scaling** — these make **LLM inference calls**; likely a major cost+latency
  scaling dimension, entirely uninvestigated.
- **ClickHouse at real volume** (millions of rows) — parts/`FINAL`/MV findings are scale-gated and
  **unproven at scale** (the laptop can't show them). Needs a seeded large dataset.
- **Multi-tenant / noisy-neighbor at scale** — modeled, not measured.
- **Live-tracing (SSE) fan-out** + per-publish Redis connection churn — identified, not measured.
- **Billing/usage-metering scaling** (O(workspaces) sequential hourly job) — identified, not measured.
- **Cost model** — the actual $ drivers (ClickHouse storage/compute, LLM inference) — not modeled.
- **Dedicated load environment** — required to validate tier scaling + all Phase-4 items.

## 10. Working constraints / preferences (for an agent operating in this repo)
- No `Co-Authored-By` in commits. Run prettier before committing in traceroot repos.
- Default: do **not** auto-commit/push or open PRs; show drafts for the owner to act on. (Pushing
  *this* WIP branch was explicitly authorized; still **no PR opened**.)
- Never post to GitHub/external services (comments/PRs) without an explicit request.
- This branch is **WIP / do-not-merge**; prototype edits are spikes. Revert any experimental
  handicaps (e.g., worker `--concurrency 1`) after use.
- The owner values **measured evidence over assumptions** and intellectually honest "this didn't
  move the needle / is scale-gated" results.

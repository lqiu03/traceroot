# ADR-002: Cache API-key validation on the ingestion path

- Status: Proposed (prototyped + load-tested on a spike branch)
- Date: 2026-05-22
- Context source: `scaling-notes/traceroot-loadtest-results.md`

## Context

Every ingestion request authenticates by having the Python `rest` service make a
**synchronous HTTP round-trip** to the Next.js `web` service
(`POST /api/internal/validate-api-key`), which does a Postgres lookup **plus a write**
(`accessKey.lastUseTime = now`) on every call.

After ADR-001 raised REST throughput, the load test showed the bottleneck move here:
during a conc=40 burst, `web` ran at **100% CPU** and `postgres` at **112%**, with
transient `503`s surfacing from the auth path. So auth becomes a per-request hot path the
moment ingestion scales.

## Decision

1. Cache the API-key validation **result** (project_id, workspace_id, billing_plan,
   ingestion_blocked) in Redis on the `rest` side, keyed by the SHA-256 key hash, with a
   short TTL (e.g. 30 s). On hit, skip the `web`+Postgres round-trip entirely.
2. Stop writing `lastUseTime` on every request — batch/throttle it (e.g. at most once per
   key per minute) or drop it to an async path.

## Consequences

- Measured effect on the spike (single load-test key → ~100% hit rate): **`web` CPU
  100% → 0%**, `postgres` roughly halved, peak RPS 21.3 → 23.7, and `validate-api-key`
  calls during the burst fell from ~one-per-request to **5 total**.
- TTL bounds staleness of `ingestion_blocked`/plan changes to ≤ TTL (acceptable; the quota
  flag is already only hourly-accurate — see the L3 note in the results doc).
- Cache should be **positive-only or short-TTL negative** to avoid caching transient auth
  failures; invalidate on key revocation if tighter consistency is needed.

## Alternatives considered

- Cache inside Next.js instead: still pays the `rest → web` HTTP hop; less effective.
- JWT/self-verifiable API keys (no lookup): larger change, best long-term.

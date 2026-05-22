# ADR-001: REST ingestion concurrency + non-blocking I/O

- Status: Proposed (prototyped + load-tested on a spike branch; not yet productionized)
- Date: 2026-05-22
- Context source: `scaling-notes/traceroot-loadtest-results.md`

## Context

The public OTLP ingestion endpoint (`POST /api/v1/public/traces`) is an async FastAPI
handler, but `docker/Dockerfile.rest` runs `uvicorn rest.main:app` with **no `--workers`**
(a single event loop), and the handler performs **synchronous boto3 calls on that loop
every request** (`ensure_bucket_exists()` = an S3 `head_bucket` per request, then
`upload_json()`), plus CPU-bound gzip/protobuf decode.

Load test (single dev host, baseline = current `main`): throughput is **flat at ~7–11
RPS regardless of concurrency** (2→80), while p99 latency rises almost exactly with
concurrency (640 ms → 25,890 ms). By Little's Law this is a **serialized bottleneck of
~10 req/s** — the blocking S3 work cannot overlap on the single event loop.

## Decision

1. Run multiple workers (`gunicorn -k uvicorn.workers.UvicornWorker -w N`, or
   `uvicorn --workers N`), sized to the container's CPU allocation.
2. Stop blocking the event loop: run boto3 `upload_json` via `asyncio.to_thread` (or an
   async S3 client), and perform the bucket-existence check **once per process at startup**,
   not per request.
3. Scale the REST ingestion tier horizontally (replicas) behind the LB, ideally as a
   deployment **separate from the dashboard/read API** so ingestion bursts don't degrade the UI.

## Consequences

- Measured effect of (1)+(2) on the spike: `rest` went from ~1 core (serialized) to ~3
  cores (292%), peak throughput ~14 → ~21 RPS, and low-concurrency p99 roughly halved.
- The bottleneck then **moved** to the per-request auth round-trip (see ADR-002) and, on
  a co-located dev host, to aggregate CPU — in production each tier scales independently.
- More workers/replicas increase connection counts to Postgres/ClickHouse/Redis/S3; size
  pools accordingly.

## Alternatives considered

- Keep one worker, only offload I/O to threads: helps, but caps at one process's GIL/CPU;
  multi-worker is needed for the CPU-bound decode.
- Fully async S3 client (aioboto3): cleaner long-term than `to_thread`, larger change.

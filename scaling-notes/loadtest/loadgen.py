"""OTLP ingestion load generator for Traceroot local stack.

Measurement tool only (not production code). Sends OTLP/protobuf trace batches
to the public ingestion endpoint as a true external client, with a closed-loop
concurrency ramp, and reports per-stage throughput + latency percentiles.
"""

import argparse
import asyncio
import os
import time
from collections import defaultdict

import httpx
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
    ExportTraceServiceRequest,
)
from opentelemetry.proto.trace.v1.trace_pb2 import Span, Status


def build_payload(num_spans: int, service_name: str) -> bytes:
    """Build one OTLP ExportTraceServiceRequest = 1 trace with fresh random IDs."""
    req = ExportTraceServiceRequest()
    rs = req.resource_spans.add()
    attr = rs.resource.attributes.add()
    attr.key = "service.name"
    attr.value.string_value = service_name
    ss = rs.scope_spans.add()
    ss.scope.name = "loadtest"
    now = time.time_ns()
    trace_id = os.urandom(16)
    root_id = os.urandom(8)
    for i in range(num_spans):
        sp = ss.spans.add()
        sp.trace_id = trace_id
        sp.span_id = root_id if i == 0 else os.urandom(8)
        if i > 0:
            sp.parent_span_id = root_id
        sp.name = f"op-{i}"
        sp.kind = Span.SPAN_KIND_SERVER if i == 0 else Span.SPAN_KIND_INTERNAL
        sp.start_time_unix_nano = now
        sp.end_time_unix_nano = now + 1_000_000
        sp.status.code = Status.STATUS_CODE_OK
    return req.SerializeToString()


def pct(values, p):
    if not values:
        return float("nan")
    s = sorted(values)
    k = max(0, min(len(s) - 1, int(round((p / 100.0) * (len(s) - 1)))))
    return s[k]


async def _worker(client, url, headers, stop_at, spans, svc, lats, errs):
    while time.monotonic() < stop_at:
        body = build_payload(spans, svc)
        t0 = time.monotonic()
        try:
            r = await client.post(url, content=body, headers=headers)
            dt = (time.monotonic() - t0) * 1000.0
            if r.status_code == 200:
                lats.append(dt)
            else:
                errs[r.status_code] += 1
        except Exception:
            errs["exc"] += 1


async def run_stage(client, url, headers, concurrency, seconds, spans, svc):
    lats: list[float] = []
    errs: dict = defaultdict(int)
    stop_at = time.monotonic() + seconds
    tasks = [
        asyncio.create_task(
            _worker(client, url, headers, stop_at, spans, svc, lats, errs)
        )
        for _ in range(concurrency)
    ]
    await asyncio.gather(*tasks)
    ok = len(lats)
    err_total = sum(errs.values())
    rps = ok / seconds
    return {
        "concurrency": concurrency,
        "ok": ok,
        "errors": err_total,
        "err_detail": dict(errs),
        "rps": rps,
        "spans_per_sec": rps * spans,
        "p50": pct(lats, 50),
        "p95": pct(lats, 95),
        "p99": pct(lats, 99),
        "max": max(lats) if lats else float("nan"),
    }


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:8000/api/v1/public/traces")
    ap.add_argument("--key", default="lt_loadtest_0001")
    ap.add_argument("--spans", type=int, default=20)
    ap.add_argument("--mode", choices=["single", "ramp"], default="ramp")
    ap.add_argument("--stages", default="2,5,10,20,40,80")
    ap.add_argument("--stage-seconds", type=int, default=20)
    args = ap.parse_args()

    headers = {
        "Authorization": f"Bearer {args.key}",
        "Content-Type": "application/x-protobuf",
    }
    limits = httpx.Limits(max_connections=500, max_keepalive_connections=200)
    timeout = httpx.Timeout(30.0)

    async with httpx.AsyncClient(limits=limits, timeout=timeout) as client:
        if args.mode == "single":
            body = build_payload(args.spans, "loadtest-svc")
            r = await client.post(args.url, content=body, headers=headers)
            print(f"status={r.status_code}")
            print(f"body={r.text[:500]}")
            return

        print(
            f"Ramp: spans/req={args.spans}  stage={args.stage_seconds}s  "
            f"url={args.url}"
        )
        print(
            f"{'conc':>5} {'ok':>7} {'err':>5} {'rps':>8} {'sp/s':>9} "
            f"{'p50ms':>7} {'p95ms':>8} {'p99ms':>8} {'maxms':>8}  errs"
        )
        for c in [int(x) for x in args.stages.split(",")]:
            res = await run_stage(
                client, args.url, headers, c, args.stage_seconds, args.spans,
                "loadtest-svc",
            )
            print(
                f"{res['concurrency']:>5} {res['ok']:>7} {res['errors']:>5} "
                f"{res['rps']:>8.1f} {res['spans_per_sec']:>9.0f} "
                f"{res['p50']:>7.1f} {res['p95']:>8.1f} {res['p99']:>8.1f} "
                f"{res['max']:>8.1f}  {res['err_detail']}"
            )


if __name__ == "__main__":
    asyncio.run(main())

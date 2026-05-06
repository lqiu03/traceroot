import {
  context as otelContext,
  trace as otelTrace,
  SpanKind as OtelSpanKind,
  SpanStatusCode,
  type Context as OtelContext,
} from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { Resource } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  type IdGenerator,
} from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

import { offsetFromAnchor } from "./anchor.js";
import { deterministicHex } from "./crypto-utils.js";
import type { SeedProject, SeedSpan, SeedTrace } from "./fixture-types.js";
import type { SeededProject } from "./prisma-seed.js";

const SDK_NAME = "@traceroot/seed";

/** Deterministic trace id (32 hex chars) from project + trace key. */
export function deterministicTraceId(projectSlug: string, traceKey: string): string {
  return deterministicHex(`trace:${projectSlug}:${traceKey}`, 32);
}

/**
 * Headers for OTLP ingest. Extracted as a pure function so unit tests can
 * lock in the exact shape (`Authorization: Bearer <key>`) — header-shape
 * regressions (e.g. someone swaps `Bearer` for `Token`, or moves the auth
 * to a different header) are a distinct failure class from the round-trip
 * guard in `prisma-seed.ts:validateSeedKeyRoundtrip`.
 */
export function buildIngestHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}

/** Deterministic span id (16 hex chars) from project + trace + span key. */
export function deterministicSpanId(
  projectSlug: string,
  traceKey: string,
  spanKey: string,
): string {
  return deterministicHex(`span:${projectSlug}:${traceKey}:${spanKey}`, 16);
}

/**
 * Pre-computed-id generator. Pops trace/span ids from queues so spans created
 * by the SDK get our deterministic seed-prefixed hex ids.
 */
class QueueIdGenerator implements IdGenerator {
  constructor(
    private readonly traceIds: string[],
    private readonly spanIds: string[],
  ) {}

  generateTraceId(): string {
    const id = this.traceIds.shift();
    if (!id) {
      throw new Error("[seed] traceId queue exhausted");
    }
    return id;
  }

  generateSpanId(): string {
    const id = this.spanIds.shift();
    if (!id) {
      throw new Error("[seed] spanId queue exhausted");
    }
    return id;
  }
}

function mapSpanKind(kind: SeedSpan["kind"]): OtelSpanKind {
  switch (kind) {
    case "AGENT":
    case "TOOL":
    case "LLM":
    case "SPAN":
      return OtelSpanKind.INTERNAL;
  }
}

function buildIdQueues(
  projectSlug: string,
  traces: readonly SeedTrace[],
): { traceIds: string[]; spanIds: string[] } {
  const traceIds: string[] = [];
  const spanIds: string[] = [];

  for (const trace of traces) {
    traceIds.push(deterministicTraceId(projectSlug, trace.key));
    // Walk spans in declaration order: parents must precede children. Each
    // tracer.startSpan() call dequeues exactly one span id.
    for (const span of trace.spans) {
      spanIds.push(deterministicSpanId(projectSlug, trace.key, span.key));
    }
  }

  return { traceIds, spanIds };
}

interface IngestProjectArgs {
  readonly project: SeedProject;
  readonly seeded: SeededProject;
  readonly anchor: Date;
  readonly endpointUrl: string;
}

/** Map status string → OTel `SpanStatusCode`. */
function mapStatus(span: SeedSpan): SpanStatusCode {
  return span.status === "ERROR" ? SpanStatusCode.ERROR : SpanStatusCode.OK;
}

/**
 * Emits one fixture project's traces through a real OTLP/proto exporter.
 *
 * The exporter posts to traceroot's public ingest endpoint with the seeded
 * project's API key; the backend goes through its normal S3 → Celery →
 * ClickHouse path. Idempotency is provided by:
 *  - deterministic seed-prefixed trace/span ids (stable across runs),
 *  - day-anchored timestamps (stable within a calendar day),
 *  - ClickHouse `ReplacingMergeTree(ch_update_time)` collapsing duplicates.
 */
export async function ingestProject(args: IngestProjectArgs): Promise<{
  readonly tracesEmitted: number;
  readonly spansEmitted: number;
}> {
  const { project, seeded, anchor, endpointUrl } = args;

  if (project.traces.length === 0) {
    return { tracesEmitted: 0, spansEmitted: 0 };
  }

  const { traceIds, spanIds } = buildIdQueues(project.slug, project.traces);

  const exporter = new OTLPTraceExporter({
    url: endpointUrl,
    headers: buildIngestHeaders(seeded.apiKey),
  });

  const provider = new BasicTracerProvider({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: project.name,
      "traceroot.project_id": seeded.id,
      "traceroot.workspace_id": seeded.workspaceId,
      "deployment.environment": "seed",
    }),
    idGenerator: new QueueIdGenerator(traceIds, spanIds),
    // Batch (not Simple) so all spans of the burst are exported in a small
    // number of OTLP POSTs rather than per-span. SimpleSpanProcessor is
    // fire-and-forget — when ingestProject finishes for a project and the
    // SDK shuts down, in-flight per-span POSTs would race the shutdown and
    // surface as `ClientDisconnect` at backend/rest/routers/public/traces.py.
    // The forceFlush+shutdown sequence below drains the batch deterministically.
    spanProcessors: [
      new BatchSpanProcessor(exporter, {
        maxQueueSize: 256,
        scheduledDelayMillis: 200,
        exportTimeoutMillis: 30_000,
        maxExportBatchSize: 64,
      }),
    ],
  });

  const tracer = provider.getTracer(SDK_NAME);

  let spansEmitted = 0;
  try {
    for (const trace of project.traces) {
      const traceAnchor = offsetFromAnchor(anchor, trace.traceOffsetMs);
      const ctxByKey = new Map<string, OtelContext>();

      // Spans are declared in topological order (root first, children after).
      for (const span of trace.spans) {
        const startTime = new Date(traceAnchor.getTime() + span.startOffsetMs);
        const endTime = new Date(traceAnchor.getTime() + span.endOffsetMs);

        const parentCtx = span.parentKey ? ctxByKey.get(span.parentKey) : undefined;
        if (span.parentKey && !parentCtx) {
          throw new Error(
            `[seed] span ${span.key} declares parentKey=${span.parentKey} which was not yet emitted`,
          );
        }

        const otelSpan = tracer.startSpan(
          span.name,
          {
            kind: mapSpanKind(span.kind),
            startTime,
            attributes: { ...span.attributes },
          },
          parentCtx,
        );

        otelSpan.setStatus({
          code: mapStatus(span),
          ...(span.statusMessage ? { message: span.statusMessage } : {}),
        });

        otelSpan.end(endTime);
        ctxByKey.set(span.key, otelTrace.setSpan(otelContext.active(), otelSpan));
        spansEmitted += 1;
      }
    }
  } finally {
    await provider.forceFlush();
    await provider.shutdown();
  }

  return { tracesEmitted: project.traces.length, spansEmitted };
}

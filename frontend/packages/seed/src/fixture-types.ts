/**
 * Pure data types for seed fixtures. No runtime logic — fixtures are arrays
 * of these literals consumed by the OTel exporter, which converts each
 * `SeedSpan` into a real OpenTelemetry span with explicit start/end times.
 *
 * Span attribute keys must match what `backend/worker/otel_transform.py`
 * recognizes (see `_KNOWN_ATTRIBUTE_PREFIXES` there): e.g.
 * `traceroot.span.input`, `traceroot.llm.model`, `llm.token_count.prompt`.
 */

export type SeedSpanKind = "LLM" | "AGENT" | "TOOL" | "SPAN";

export type SeedSpanStatus = "OK" | "ERROR";

export interface SeedSpan {
  readonly key: string;
  readonly name: string;
  readonly kind: SeedSpanKind;
  readonly parentKey: string | null;
  readonly startOffsetMs: number;
  readonly endOffsetMs: number;
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
  readonly status: SeedSpanStatus;
  readonly statusMessage?: string;
}

export interface SeedTrace {
  readonly key: string;
  readonly name: string;
  readonly traceOffsetMs: number;
  readonly spans: readonly SeedSpan[];
}

export interface SeedProject {
  readonly slug: string;
  readonly name: string;
  readonly workspaceSlug: string;
  readonly traces: readonly SeedTrace[];
}

export interface SeedWorkspace {
  readonly slug: string;
  readonly name: string;
}

/**
 * Experiment-pipeline fixture for `seed-prj-labs-demo`. Three instances jittered
 * across the seed-anchor day. Demonstrates a parallel-branch topology that none
 * of the existing fixtures cover: variant_a and variant_b run concurrently
 * under a shared parent and their time ranges deliberately overlap so the UI
 * waterfall must render parallel bars (not sequential).
 *
 * Topology — single root with overlapping siblings:
 *   experiment.run           0    → 1100  (root)
 *     dataset.load           50   → 200
 *     llm.variant_a          220  → 850   ← runs concurrently
 *     llm.variant_b          230  → 920   ← with variant_a (overlap 230..850)
 *     eval.compare           940  → 1050  (strictly after both variants finish)
 *     metrics.aggregate      1060 → 1090
 *
 * Instance 2 has variant_b set to ERROR (rate_limit) — exercises the trace-
 * detail panel's error rendering on a non-checkout project. Instances 1 and 3
 * are all-success.
 */
import type { SeedSpan, SeedTrace } from "../fixture-types.js";

interface InstanceSpec {
  readonly traceKey: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly traceOffsetMs: number;
  readonly variantBStatus: "OK" | "ERROR";
  readonly variantBStatusMessage?: string;
  readonly variantAModel: string;
  readonly variantBModel: string;
  readonly winner: "variant_a" | "variant_b" | "tie";
  readonly evalScoreA: number;
  readonly evalScoreB: number;
}

function buildSpans(spec: InstanceSpec): SeedSpan[] {
  const sampleDataset = JSON.stringify({
    name: "qa-eval-2026-Q1",
    rows: 128,
    fields: ["question", "expected_answer"],
  });

  const variantAOutput = JSON.stringify({
    answer:
      "TraceRoot ingests OTLP via FastAPI, durably stores it in S3, then a Celery worker writes to ClickHouse.",
    finish_reason: "stop",
  });

  const variantBOutput =
    spec.variantBStatus === "ERROR"
      ? JSON.stringify({ error: "rate_limit", retries: 3 })
      : JSON.stringify({
          answer:
            "TraceRoot's pipeline: OTLP → FastAPI → S3 buffer → Celery worker → ClickHouse (ReplacingMergeTree).",
          finish_reason: "stop",
        });

  return [
    {
      key: "root",
      name: "experiment.run",
      kind: "AGENT",
      parentKey: null,
      startOffsetMs: 0,
      endOffsetMs: 1100,
      status: "OK",
      attributes: {
        "traceroot.span.type": "AGENT",
        "traceroot.span.input": JSON.stringify({
          dataset: "qa-eval-2026-Q1",
          variants: [spec.variantAModel, spec.variantBModel],
        }),
        "traceroot.span.output": JSON.stringify({
          winner: spec.winner,
          score_a: spec.evalScoreA,
          score_b: spec.evalScoreB,
        }),
        "traceroot.trace.user_id": spec.userId,
        "traceroot.trace.session_id": spec.sessionId,
        "traceroot.git.repo": "lqiu03/traceroot",
        "traceroot.git.ref": "feat/seed-v1.1",
        "traceroot.git.source_file": "frontend/packages/seed/src/fixtures/f5-experiment-pipeline.ts",
        "traceroot.git.source_line": 1,
        "traceroot.git.source_function": "experiment.run",
        "traceroot.environment": "development",
      },
    },
    {
      key: "dataset.load",
      name: "dataset.load",
      kind: "TOOL",
      parentKey: "root",
      startOffsetMs: 50,
      endOffsetMs: 200,
      status: "OK",
      attributes: {
        "traceroot.span.type": "TOOL",
        "traceroot.span.input": JSON.stringify({ name: "qa-eval-2026-Q1" }),
        "traceroot.span.output": sampleDataset,
        "traceroot.git.source_file": "examples/eval/dataset.py",
        "traceroot.git.source_line": 17,
        "traceroot.git.source_function": "load_dataset",
      },
    },
    {
      key: "llm.variant_a",
      name: "llm.variant_a",
      kind: "LLM",
      parentKey: "root",
      // Overlaps with variant_b (220..850 vs 230..920) — UI waterfall must
      // render these as parallel bars to be correct.
      startOffsetMs: 220,
      endOffsetMs: 850,
      status: "OK",
      attributes: {
        "traceroot.span.type": "LLM",
        "traceroot.llm.model": spec.variantAModel,
        "gen_ai.system": "openai",
        "gen_ai.request.model": spec.variantAModel,
        "llm.token_count.prompt": 480,
        "llm.token_count.completion": 132,
        "llm.token_count.total": 612,
        "traceroot.span.input": JSON.stringify({
          system: "You are a concise QA assistant.",
          variant: "A",
        }),
        "traceroot.span.output": variantAOutput,
      },
    },
    {
      key: "llm.variant_b",
      name: "llm.variant_b",
      kind: "LLM",
      parentKey: "root",
      startOffsetMs: 230,
      endOffsetMs: 920,
      status: spec.variantBStatus,
      ...(spec.variantBStatusMessage ? { statusMessage: spec.variantBStatusMessage } : {}),
      attributes: {
        "traceroot.span.type": "LLM",
        "traceroot.llm.model": spec.variantBModel,
        "gen_ai.system": "anthropic",
        "gen_ai.request.model": spec.variantBModel,
        "llm.token_count.prompt": spec.variantBStatus === "ERROR" ? 0 : 482,
        "llm.token_count.completion": spec.variantBStatus === "ERROR" ? 0 : 119,
        "llm.token_count.total": spec.variantBStatus === "ERROR" ? 0 : 601,
        "traceroot.span.input": JSON.stringify({
          system: "You are a concise QA assistant.",
          variant: "B",
        }),
        "traceroot.span.output": variantBOutput,
      },
    },
    {
      key: "eval.compare",
      name: "eval.compare",
      kind: "TOOL",
      parentKey: "root",
      startOffsetMs: 940,
      endOffsetMs: 1050,
      status: "OK",
      attributes: {
        "traceroot.span.type": "TOOL",
        "traceroot.span.input": JSON.stringify({
          variant_a_status: "OK",
          variant_b_status: spec.variantBStatus,
        }),
        "traceroot.span.output": JSON.stringify({
          winner: spec.winner,
          score_a: spec.evalScoreA,
          score_b: spec.evalScoreB,
        }),
      },
    },
    {
      key: "metrics.aggregate",
      name: "metrics.aggregate",
      kind: "TOOL",
      parentKey: "root",
      startOffsetMs: 1060,
      endOffsetMs: 1090,
      status: "OK",
      attributes: {
        "traceroot.span.type": "TOOL",
        "traceroot.span.input": JSON.stringify({ run_id: spec.traceKey }),
        "traceroot.span.output": JSON.stringify({
          mean_latency_ms: 685,
          variant_a_tokens: 612,
          variant_b_tokens: spec.variantBStatus === "ERROR" ? 0 : 601,
        }),
      },
    },
  ];
}

const INSTANCES: readonly InstanceSpec[] = [
  {
    traceKey: "f5-experiment-pipeline-1",
    userId: "seed-user-labs-1",
    sessionId: "seed-session-labs-001",
    traceOffsetMs: 90_000,
    variantBStatus: "OK",
    variantAModel: "gpt-4o-mini",
    variantBModel: "claude-3-5-sonnet",
    winner: "variant_b",
    evalScoreA: 0.78,
    evalScoreB: 0.84,
  },
  {
    traceKey: "f5-experiment-pipeline-2",
    userId: "seed-user-labs-2",
    sessionId: "seed-session-labs-002",
    traceOffsetMs: 540_000,
    variantBStatus: "ERROR",
    variantBStatusMessage: "Anthropic rate_limit_error after 3 retries (model=claude-3-5-sonnet)",
    variantAModel: "gpt-4o-mini",
    variantBModel: "claude-3-5-sonnet",
    winner: "variant_a",
    evalScoreA: 0.81,
    evalScoreB: 0.0,
  },
  {
    traceKey: "f5-experiment-pipeline-3",
    userId: "seed-user-labs-3",
    sessionId: "seed-session-labs-003",
    traceOffsetMs: 1_500_000,
    variantBStatus: "OK",
    variantAModel: "gpt-4o-mini",
    variantBModel: "claude-3-5-haiku",
    winner: "tie",
    evalScoreA: 0.79,
    evalScoreB: 0.79,
  },
];

export const f5ExperimentPipelineTraces: readonly SeedTrace[] = INSTANCES.map((spec) => ({
  key: spec.traceKey,
  name: "experiment.run",
  traceOffsetMs: spec.traceOffsetMs,
  spans: buildSpans(spec),
}));

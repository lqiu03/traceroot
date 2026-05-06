/**
 * Search-RAG fixture for `seed-prj-search`. Three instances jittered across
 * the seed-anchor day so the trace list looks alive.
 *
 * Topology — single root with serial children (matches f1 / OpenInference RAG):
 *   search.query             0   → 700
 *     embeddings.embed       20  → 120
 *     vector.search          130 → 350
 *     results.rerank         360 → 500
 *     response.format        510 → 680
 *
 * All three instances are success-path. Error rendering is exercised by f5's
 * variant_b ERROR span and by f2's tool failure under checkout.
 */
import type { SeedSpan, SeedTrace } from "../fixture-types.js";

interface InstanceSpec {
  readonly traceKey: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly traceOffsetMs: number;
  readonly query: string;
  readonly topResultSource: string;
  readonly topResultSnippet: string;
  readonly answer: string;
  readonly model: string;
  readonly tokenCounts: { prompt: number; completion: number; total: number };
}

function buildSpans(spec: InstanceSpec): SeedSpan[] {
  const retrievedChunks = JSON.stringify([
    { source: spec.topResultSource, score: 0.92, text: spec.topResultSnippet },
    {
      source: "docs/getting-started/quickstart.mdx",
      score: 0.78,
      text: "TraceRoot ships a TypeScript SDK and a Python SDK; both auto-instrument popular agent frameworks.",
    },
  ]);

  return [
    {
      key: "root",
      name: "search.query",
      kind: "AGENT",
      parentKey: null,
      startOffsetMs: 0,
      endOffsetMs: 700,
      status: "OK",
      attributes: {
        "traceroot.span.type": "AGENT",
        "traceroot.span.input": spec.query,
        "traceroot.span.output": spec.answer,
        "traceroot.trace.user_id": spec.userId,
        "traceroot.trace.session_id": spec.sessionId,
        "traceroot.git.repo": "lqiu03/traceroot",
        "traceroot.git.ref": "feat/seed-v1.1",
        "traceroot.git.source_file": "frontend/packages/seed/src/fixtures/f4-search-rag.ts",
        "traceroot.git.source_line": 1,
        "traceroot.git.source_function": "search.query",
        "traceroot.environment": "development",
      },
    },
    {
      key: "embeddings.embed",
      name: "embeddings.embed",
      kind: "SPAN",
      parentKey: "root",
      startOffsetMs: 20,
      endOffsetMs: 120,
      status: "OK",
      attributes: {
        "traceroot.span.type": "SPAN",
        "traceroot.llm.model": "text-embedding-3-small",
        "gen_ai.system": "openai",
        "gen_ai.request.model": "text-embedding-3-small",
        "llm.token_count.prompt": Math.ceil(spec.query.length / 4),
        "llm.token_count.total": Math.ceil(spec.query.length / 4),
        "traceroot.span.input": spec.query,
        "traceroot.span.output": JSON.stringify({ vector_dim: 1536 }),
      },
    },
    {
      key: "vector.search",
      name: "vector.search",
      kind: "TOOL",
      parentKey: "root",
      startOffsetMs: 130,
      endOffsetMs: 350,
      status: "OK",
      attributes: {
        "traceroot.span.type": "TOOL",
        "traceroot.span.input": JSON.stringify({ index: "docs-v2", top_k: 8 }),
        "traceroot.span.output": JSON.stringify({ matches: 8, latency_ms: 218 }),
        "traceroot.git.source_file": "examples/rag/vector_search.py",
        "traceroot.git.source_line": 31,
        "traceroot.git.source_function": "knn_search",
      },
    },
    {
      key: "results.rerank",
      name: "results.rerank",
      kind: "TOOL",
      parentKey: "root",
      startOffsetMs: 360,
      endOffsetMs: 500,
      status: "OK",
      attributes: {
        "traceroot.span.type": "TOOL",
        "traceroot.llm.model": "rerank-v3",
        "gen_ai.system": "cohere",
        "traceroot.span.input": JSON.stringify({ candidates: 8, top_n: 2 }),
        "traceroot.span.output": retrievedChunks,
      },
    },
    {
      key: "response.format",
      name: "response.format",
      kind: "LLM",
      parentKey: "root",
      startOffsetMs: 510,
      endOffsetMs: 680,
      status: "OK",
      attributes: {
        "traceroot.span.type": "LLM",
        "traceroot.llm.model": spec.model,
        "gen_ai.system": "openai",
        "gen_ai.request.model": spec.model,
        "llm.token_count.prompt": spec.tokenCounts.prompt,
        "llm.token_count.completion": spec.tokenCounts.completion,
        "llm.token_count.total": spec.tokenCounts.total,
        "traceroot.span.input": JSON.stringify({
          system: "You are a concise documentation assistant.",
          context: retrievedChunks,
          query: spec.query,
        }),
        "traceroot.span.output": spec.answer,
      },
    },
  ];
}

const INSTANCES: readonly InstanceSpec[] = [
  {
    traceKey: "f4-search-rag-1",
    userId: "seed-user-acme-3",
    sessionId: "seed-session-search-001",
    traceOffsetMs: 60_000,
    query: "How does TraceRoot store OTel traces?",
    topResultSource: "docs/ARCHITECTURE.md",
    topResultSnippet:
      "TraceRoot ingests OTLP via FastAPI, buffers JSON to S3, then Celery writes to ClickHouse traces/spans.",
    answer:
      "TraceRoot ingests OTLP via FastAPI, durably stores it in S3, then a Celery worker writes to ClickHouse traces and spans tables (ReplacingMergeTree dedup).",
    model: "gpt-4o-mini",
    tokenCounts: { prompt: 384, completion: 92, total: 476 },
  },
  {
    traceKey: "f4-search-rag-2",
    userId: "seed-user-acme-4",
    sessionId: "seed-session-search-002",
    traceOffsetMs: 660_000,
    query: "Which agent frameworks does TraceRoot auto-instrument?",
    topResultSource: "docs/integrations/overview.mdx",
    topResultSnippet:
      "TraceRoot auto-instruments OpenAI, Anthropic, LangChain, LangGraph, OpenAI Agents SDK, Agno, Google ADK, and more.",
    answer:
      "TraceRoot auto-instruments OpenAI, Anthropic, LangChain, LangGraph, OpenAI Agents SDK, Agno, Google ADK, plus several other agent frameworks.",
    model: "gpt-4o-mini",
    tokenCounts: { prompt: 312, completion: 64, total: 376 },
  },
  {
    traceKey: "f4-search-rag-3",
    userId: "seed-user-acme-5",
    sessionId: "seed-session-search-003",
    traceOffsetMs: 1_860_000,
    query: "How do I run TraceRoot locally for contributing?",
    topResultSource: "docs/developer/self-hosting.mdx",
    topResultSnippet:
      "Run `make dev` to start PostgreSQL, ClickHouse, MinIO, and Redis in Docker, then the API and UI locally.",
    answer:
      "Run `make dev` to start the infra services in Docker, then the API and UI run locally via tmux. See CONTRIBUTING.md for details.",
    model: "gpt-4o-mini",
    tokenCounts: { prompt: 296, completion: 71, total: 367 },
  },
];

export const f4SearchRagTraces: readonly SeedTrace[] = INSTANCES.map((spec) => ({
  key: spec.traceKey,
  name: "search.query",
  traceOffsetMs: spec.traceOffsetMs,
  spans: buildSpans(spec),
}));

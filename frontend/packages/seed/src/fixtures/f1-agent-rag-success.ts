import type { SeedSpan, SeedTrace } from "../fixture-types.js";

const F1_KEY = "f1-agent-rag-success";

const sampleUserQuery = "Summarize how TraceRoot stores OTel traces.";

const sampleRetrievedChunks = JSON.stringify([
  {
    source: "docs/ARCHITECTURE.md",
    score: 0.92,
    text: "TraceRoot ingests OTLP via FastAPI, buffers JSON to S3, then a Celery worker writes to ClickHouse traces/spans tables.",
  },
  {
    source: "backend/db/clickhouse/migrations/002_create_spans.sql",
    score: 0.81,
    text: "spans table is ReplacingMergeTree(ch_update_time) ordered by (project_id, span_kind, toDate(span_start_time), span_id).",
  },
]);

const sampleLlmMessages = JSON.stringify([
  { role: "system", content: "You are a TraceRoot product assistant." },
  { role: "user", content: sampleUserQuery },
  {
    role: "user",
    content: `Context:\n${sampleRetrievedChunks}\n\nAnswer concisely.`,
  },
]);

const sampleLlmResponse = JSON.stringify({
  role: "assistant",
  content:
    "TraceRoot ingests OTLP traces through a FastAPI public endpoint, durably buffers them as JSON in S3, then a Celery worker transforms and inserts the records into ClickHouse traces and spans tables (ReplacingMergeTree for native dedupe).",
  finish_reason: "stop",
});

const spans: SeedSpan[] = [
  {
    key: "root",
    name: "agent.run",
    kind: "AGENT",
    parentKey: null,
    startOffsetMs: 0,
    endOffsetMs: 4200,
    status: "OK",
    attributes: {
      "traceroot.span.type": "AGENT",
      "traceroot.span.input": sampleUserQuery,
      "traceroot.span.output": JSON.parse(sampleLlmResponse).content,
      "traceroot.trace.user_id": "seed-user-acme-1",
      "traceroot.trace.session_id": "seed-session-acme-001",
      "traceroot.git.repo": "lqiu03/traceroot",
      "traceroot.git.ref": "feat/seed-script",
      "traceroot.git.source_file": "frontend/packages/seed/src/fixtures/f1-agent-rag-success.ts",
      "traceroot.git.source_line": 1,
      "traceroot.git.source_function": "agent.run",
      "traceroot.environment": "development",
    },
  },
  {
    key: "rag.retrieve",
    name: "rag.retrieve",
    kind: "TOOL",
    parentKey: "root",
    startOffsetMs: 80,
    endOffsetMs: 380,
    status: "OK",
    attributes: {
      "traceroot.span.type": "TOOL",
      "traceroot.span.input": JSON.stringify({
        query: sampleUserQuery,
        top_k: 4,
      }),
      "traceroot.span.output": sampleRetrievedChunks,
      "traceroot.git.source_file": "examples/rag/retrieve.py",
      "traceroot.git.source_line": 42,
      "traceroot.git.source_function": "retrieve_chunks",
    },
  },
  {
    key: "vector.search",
    name: "vector.search",
    kind: "SPAN",
    parentKey: "rag.retrieve",
    startOffsetMs: 110,
    endOffsetMs: 290,
    status: "OK",
    attributes: {
      "traceroot.span.type": "SPAN",
      "traceroot.span.input": JSON.stringify({
        index: "docs-v2",
        query: sampleUserQuery,
      }),
      "traceroot.span.output": JSON.stringify({ matches: 4, latency_ms: 178 }),
    },
  },
  {
    key: "llm.compose",
    name: "llm.compose",
    kind: "LLM",
    parentKey: "root",
    startOffsetMs: 420,
    endOffsetMs: 3900,
    status: "OK",
    attributes: {
      "traceroot.span.type": "LLM",
      "traceroot.llm.model": "gpt-4o-mini",
      "gen_ai.system": "openai",
      "gen_ai.request.model": "gpt-4o-mini",
      "llm.token_count.prompt": 412,
      "llm.token_count.completion": 187,
      "llm.token_count.total": 599,
      "traceroot.span.input": sampleLlmMessages,
      "traceroot.span.output": sampleLlmResponse,
    },
  },
  {
    key: "llm.summarize",
    name: "llm.summarize",
    kind: "LLM",
    parentKey: "root",
    startOffsetMs: 3950,
    endOffsetMs: 4180,
    status: "OK",
    attributes: {
      "traceroot.span.type": "LLM",
      "traceroot.llm.model": "gpt-4o-mini",
      "gen_ai.system": "openai",
      "gen_ai.request.model": "gpt-4o-mini",
      "llm.token_count.prompt": 96,
      "llm.token_count.completion": 38,
      "llm.token_count.total": 134,
      "traceroot.span.input": JSON.stringify({
        instruction: "Summarize in one sentence.",
        text: JSON.parse(sampleLlmResponse).content,
      }),
      "traceroot.span.output":
        "TraceRoot writes OTLP through FastAPI → S3 → Celery → ClickHouse with ReplacingMergeTree.",
    },
  },
];

export const f1AgentRagSuccess: SeedTrace = {
  key: F1_KEY,
  name: "agent.run",
  traceOffsetMs: 60_000,
  spans,
};

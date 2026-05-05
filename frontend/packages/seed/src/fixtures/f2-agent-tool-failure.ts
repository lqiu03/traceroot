import type { SeedSpan, SeedTrace } from "../fixture-types.js";

const F2_KEY = "f2-agent-tool-failure";

const failingQuery = "What is the price of TSLA right now?";

const spans: SeedSpan[] = [
  {
    key: "root",
    name: "agent.run",
    kind: "AGENT",
    parentKey: null,
    startOffsetMs: 0,
    endOffsetMs: 30_400,
    status: "OK",
    attributes: {
      "traceroot.span.type": "AGENT",
      "traceroot.span.input": failingQuery,
      "traceroot.span.output": "Sorry — the live-quote tool timed out, please try again.",
      "traceroot.trace.user_id": "seed-user-acme-2",
      "traceroot.trace.session_id": "seed-session-acme-002",
      "traceroot.git.repo": "lqiu03/traceroot",
      "traceroot.git.ref": "feat/seed-script",
      "traceroot.git.source_file": "frontend/packages/seed/src/fixtures/f2-agent-tool-failure.ts",
      "traceroot.git.source_line": 1,
      "traceroot.git.source_function": "agent.run",
      "traceroot.environment": "development",
    },
  },
  {
    key: "llm.plan",
    name: "llm.plan",
    kind: "LLM",
    parentKey: "root",
    startOffsetMs: 60,
    endOffsetMs: 410,
    status: "OK",
    attributes: {
      "traceroot.span.type": "LLM",
      "traceroot.llm.model": "gpt-4o-mini",
      "gen_ai.system": "openai",
      "gen_ai.request.model": "gpt-4o-mini",
      "llm.token_count.prompt": 88,
      "llm.token_count.completion": 24,
      "llm.token_count.total": 112,
      "traceroot.span.input": JSON.stringify([
        {
          role: "system",
          content: "Decide whether to call live_quote(symbol).",
        },
        { role: "user", content: failingQuery },
      ]),
      "traceroot.span.output": JSON.stringify({
        tool: "live_quote",
        arguments: { symbol: "TSLA" },
      }),
    },
  },
  {
    key: "tool.live_quote",
    name: "tool.live_quote",
    kind: "TOOL",
    parentKey: "root",
    startOffsetMs: 460,
    endOffsetMs: 30_350,
    status: "ERROR",
    statusMessage: "Upstream provider timed out after 30s (provider=tradingview, symbol=TSLA)",
    attributes: {
      "traceroot.span.type": "TOOL",
      "traceroot.span.input": JSON.stringify({ symbol: "TSLA" }),
      "traceroot.span.output": JSON.stringify({
        error: "timeout",
        provider: "tradingview",
        retries: 2,
      }),
      "traceroot.git.source_file": "examples/tools/live_quote.py",
      "traceroot.git.source_line": 73,
      "traceroot.git.source_function": "fetch_quote",
    },
  },
];

export const f2AgentToolFailure: SeedTrace = {
  key: F2_KEY,
  name: "agent.run",
  traceOffsetMs: 240_000,
  spans,
};

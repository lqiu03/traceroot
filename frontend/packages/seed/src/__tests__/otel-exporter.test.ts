import { describe, expect, it } from "vitest";

import { deterministicSpanId, deterministicTraceId } from "../otel-exporter.js";

describe("deterministicTraceId", () => {
  it("returns a 32-hex-char trace id", () => {
    const id = deterministicTraceId("checkout", "f1-agent-rag-success");
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("is stable across calls", () => {
    expect(deterministicTraceId("checkout", "f1")).toBe(deterministicTraceId("checkout", "f1"));
  });

  it("differs by project slug or trace key", () => {
    expect(deterministicTraceId("checkout", "f1")).not.toBe(deterministicTraceId("search", "f1"));
    expect(deterministicTraceId("checkout", "f1")).not.toBe(deterministicTraceId("checkout", "f2"));
  });
});

describe("deterministicSpanId", () => {
  it("returns a 16-hex-char span id", () => {
    const id = deterministicSpanId("checkout", "f1", "root");
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is stable across calls", () => {
    expect(deterministicSpanId("checkout", "f1", "root")).toBe(
      deterministicSpanId("checkout", "f1", "root"),
    );
  });

  it("differs by span key within the same trace", () => {
    expect(deterministicSpanId("checkout", "f1", "root")).not.toBe(
      deterministicSpanId("checkout", "f1", "child"),
    );
  });
});

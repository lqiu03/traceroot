import { describe, expect, it } from "vitest";

import { buildIngestHeaders, deterministicSpanId, deterministicTraceId } from "../otel-exporter.js";

describe("buildIngestHeaders", () => {
  it("emits an Authorization: Bearer <key> header (and only that)", () => {
    const headers = buildIngestHeaders("tr_seed_abc");
    expect(headers).toEqual({ Authorization: "Bearer tr_seed_abc" });
  });

  it("preserves the literal key bytes verbatim — no mutation, encoding, or truncation", () => {
    const key = "tr_seed_a1f20422080c0208d65c30c9aeb09f6271495285ba038a34";
    expect(buildIngestHeaders(key).Authorization).toBe(`Bearer ${key}`);
  });

  it("uses the spelling 'Bearer ' (capital B, single space) — not 'bearer', 'Token ', etc.", () => {
    const auth = buildIngestHeaders("k").Authorization;
    expect(auth.startsWith("Bearer ")).toBe(true);
    // case-sensitive: lowercase 'bearer ' must NOT be the prefix
    expect(auth.startsWith("bearer ")).toBe(false);
    expect(auth.startsWith("Token ")).toBe(false);
    expect(auth.startsWith("Bearer  ")).toBe(false); // no double space
  });

  it("does not introduce alternate auth headers (X-API-Key etc.)", () => {
    const headers = buildIngestHeaders("k");
    expect(headers["X-API-Key"]).toBeUndefined();
    expect(headers["x-api-key"]).toBeUndefined();
    expect(Object.keys(headers)).toEqual(["Authorization"]);
  });
});

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

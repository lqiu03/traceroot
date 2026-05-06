import { describe, expect, it } from "vitest";

import {
  deterministicFindingId,
  deterministicRunId,
  findingSummaryForSlot,
  severityForSlot,
} from "../detector-discovery.js";

describe("deterministicRunId", () => {
  it("starts with the seed-run- prefix (used by reset/discovery scope predicates)", () => {
    expect(deterministicRunId("d1", 0)).toMatch(/^seed-run-/);
  });

  it("includes the detector id verbatim so DELETE WHERE detector_id IN (...) works", () => {
    expect(deterministicRunId("seed-det-failure-checkout", 0)).toContain(
      "seed-det-failure-checkout",
    );
  });

  it("is stable across calls", () => {
    expect(deterministicRunId("d1", 5)).toBe(deterministicRunId("d1", 5));
  });

  it("differs by detector or by slot — guaranteeing no run_id collisions", () => {
    expect(deterministicRunId("d1", 0)).not.toBe(deterministicRunId("d1", 1));
    expect(deterministicRunId("d1", 0)).not.toBe(deterministicRunId("d2", 0));
  });
});

describe("deterministicFindingId", () => {
  it("starts with the seed-find- prefix", () => {
    expect(deterministicFindingId("d1", 0)).toMatch(/^seed-find-/);
  });

  it("is stable across calls", () => {
    expect(deterministicFindingId("d1", 5)).toBe(deterministicFindingId("d1", 5));
  });

  it("differs from the run id at the same (detector, slot) — they are distinct ids", () => {
    expect(deterministicFindingId("d1", 0)).not.toBe(deterministicRunId("d1", 0));
  });
});

describe("findingSummaryForSlot", () => {
  it("returns one of the documented phrase library strings", () => {
    const phrase = findingSummaryForSlot(3);
    expect(typeof phrase).toBe("string");
    expect(phrase.length).toBeGreaterThan(0);
  });

  it("rotates through the library by slot index", () => {
    expect(findingSummaryForSlot(0)).not.toBe(findingSummaryForSlot(1));
  });

  it("wraps around modulo library length — stable for any slot N", () => {
    expect(findingSummaryForSlot(0)).toBe(findingSummaryForSlot(10));
  });
});

describe("severityForSlot", () => {
  it("returns one of the four allowed levels", () => {
    expect(["low", "medium", "high", "critical"]).toContain(severityForSlot(0));
    expect(["low", "medium", "high", "critical"]).toContain(severityForSlot(7));
  });

  it("is stable across calls", () => {
    expect(severityForSlot(5)).toBe(severityForSlot(5));
  });
});

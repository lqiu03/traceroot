import { describe, expect, it } from "vitest";

import {
  SEED_PROJECTS,
  SEED_WORKSPACES,
  f1AgentRagSuccess,
  f2AgentToolFailure,
} from "../fixtures/index.js";
import type { SeedTrace } from "../fixture-types.js";

function assertParentLinkage(trace: SeedTrace) {
  const keys = new Set(trace.spans.map((s) => s.key));
  expect(keys.size).toBe(trace.spans.length);
  for (const span of trace.spans) {
    if (span.parentKey === null) continue;
    expect(keys.has(span.parentKey)).toBe(true);
  }
  // Exactly one root.
  const roots = trace.spans.filter((s) => s.parentKey === null);
  expect(roots).toHaveLength(1);
}

function assertTopologicalOrder(trace: SeedTrace) {
  const seen = new Set<string>();
  for (const span of trace.spans) {
    if (span.parentKey !== null) {
      expect(seen.has(span.parentKey)).toBe(true);
    }
    seen.add(span.key);
  }
}

describe("SEED_WORKSPACES", () => {
  it("declares 2 workspaces (acme, labs) — multi-workspace exercises tenant isolation", () => {
    expect(SEED_WORKSPACES.map((w) => w.slug).sort()).toEqual(["acme", "labs"]);
  });
});

describe("SEED_PROJECTS", () => {
  it("declares 3 projects across the 2 workspaces", () => {
    expect(SEED_PROJECTS).toHaveLength(3);
  });

  it("each project has unique slug", () => {
    const slugs = SEED_PROJECTS.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("at least one project is intentionally empty (exercises empty-state UI)", () => {
    expect(SEED_PROJECTS.filter((p) => p.traces.length === 0).length).toBeGreaterThanOrEqual(1);
  });

  it("every project's workspaceSlug matches a declared workspace", () => {
    const wsSlugs = new Set(SEED_WORKSPACES.map((w) => w.slug));
    for (const p of SEED_PROJECTS) {
      expect(wsSlugs.has(p.workspaceSlug)).toBe(true);
    }
  });
});

describe("F1 — agent + RAG happy path", () => {
  it("has a multi-level span tree with at least 5 spans", () => {
    expect(f1AgentRagSuccess.spans.length).toBeGreaterThanOrEqual(5);
  });

  it("includes all four span kinds (LLM, AGENT, TOOL, SPAN) for badge coverage", () => {
    const kinds = new Set(f1AgentRagSuccess.spans.map((s) => s.kind));
    expect(kinds.has("AGENT")).toBe(true);
    expect(kinds.has("TOOL")).toBe(true);
    expect(kinds.has("LLM")).toBe(true);
    expect(kinds.has("SPAN")).toBe(true);
  });

  it("has valid parent linkage and topological ordering", () => {
    assertParentLinkage(f1AgentRagSuccess);
    assertTopologicalOrder(f1AgentRagSuccess);
  });

  it("at least one LLM span has model + token attributes for cost calculation", () => {
    const llm = f1AgentRagSuccess.spans.find((s) => s.kind === "LLM");
    expect(llm).toBeDefined();
    expect(llm!.attributes["traceroot.llm.model"]).toBeDefined();
    expect(llm!.attributes["llm.token_count.prompt"]).toBeDefined();
    expect(llm!.attributes["llm.token_count.completion"]).toBeDefined();
  });
});

describe("F2 — agent + tool failure", () => {
  it("has at least one ERROR span with statusMessage (exercises error UI)", () => {
    const errorSpans = f2AgentToolFailure.spans.filter((s) => s.status === "ERROR");
    expect(errorSpans.length).toBeGreaterThanOrEqual(1);
    expect(errorSpans[0].statusMessage).toBeTruthy();
  });

  it("has valid parent linkage and topological ordering", () => {
    assertParentLinkage(f2AgentToolFailure);
    assertTopologicalOrder(f2AgentToolFailure);
  });
});

describe("Fixture trace + span timing", () => {
  for (const project of SEED_PROJECTS) {
    for (const trace of project.traces) {
      it(`${project.slug}/${trace.key}: every span endOffsetMs > startOffsetMs`, () => {
        for (const span of trace.spans) {
          expect(span.endOffsetMs).toBeGreaterThan(span.startOffsetMs);
        }
      });
    }
  }
});

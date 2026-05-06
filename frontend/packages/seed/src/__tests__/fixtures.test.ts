import { describe, expect, it } from "vitest";

import {
  SEED_PROJECTS,
  SEED_WORKSPACES,
  buildSeedProjects,
  f1AgentRagSuccess,
  f2AgentToolFailure,
  f4SearchRagTraces,
  f5ExperimentPipelineTraces,
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

  it("default mode: every project has trace data (no surprise-empty projects in the UI)", () => {
    const projects = buildSeedProjects({});
    expect(projects).toHaveLength(3);
    for (const p of projects) {
      expect(p.traces.length).toBeGreaterThan(0);
    }
  });

  it("SEED_INCLUDE_EMPTY=true: search and labs-demo revert to empty (covers empty-state UI)", () => {
    const projects = buildSeedProjects({ SEED_INCLUDE_EMPTY: "true" });
    const bySlug = new Map(projects.map((p) => [p.slug, p]));
    expect(bySlug.get("checkout")!.traces.length).toBeGreaterThan(0);
    expect(bySlug.get("search")!.traces.length).toBe(0);
    expect(bySlug.get("labs-demo")!.traces.length).toBe(0);
  });

  it("SEED_INCLUDE_EMPTY=1 (numeric truthy) is also accepted", () => {
    const projects = buildSeedProjects({ SEED_INCLUDE_EMPTY: "1" });
    const bySlug = new Map(projects.map((p) => [p.slug, p]));
    expect(bySlug.get("search")!.traces.length).toBe(0);
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

describe("F4 — search RAG (3 instances)", () => {
  it("emits exactly 3 instances (cheap volume win without procedural generator)", () => {
    expect(f4SearchRagTraces).toHaveLength(3);
  });

  it("every instance has unique trace key (no id collisions across re-runs)", () => {
    const keys = f4SearchRagTraces.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("every instance has valid parent linkage and topological ordering", () => {
    for (const trace of f4SearchRagTraces) {
      assertParentLinkage(trace);
      assertTopologicalOrder(trace);
    }
  });

  it("instances are jittered across distinct anchor offsets (not co-located)", () => {
    const offsets = f4SearchRagTraces.map((t) => t.traceOffsetMs);
    expect(new Set(offsets).size).toBe(offsets.length);
  });

  it("all instances are success-path (error rendering covered by f2 + f5 instance 2)", () => {
    for (const trace of f4SearchRagTraces) {
      const errors = trace.spans.filter((s) => s.status === "ERROR");
      expect(errors).toHaveLength(0);
    }
  });
});

describe("F5 — experiment pipeline (parallel branches, mixed status)", () => {
  it("emits exactly 3 instances", () => {
    expect(f5ExperimentPipelineTraces).toHaveLength(3);
  });

  it("every instance has unique trace key", () => {
    const keys = f5ExperimentPipelineTraces.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("every instance has valid parent linkage", () => {
    for (const trace of f5ExperimentPipelineTraces) {
      assertParentLinkage(trace);
    }
  });

  it("variant_a and variant_b overlap in time on every instance (UI must render parallel)", () => {
    for (const trace of f5ExperimentPipelineTraces) {
      const a = trace.spans.find((s) => s.key === "llm.variant_a");
      const b = trace.spans.find((s) => s.key === "llm.variant_b");
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      const overlapStart = Math.max(a!.startOffsetMs, b!.startOffsetMs);
      const overlapEnd = Math.min(a!.endOffsetMs, b!.endOffsetMs);
      expect(overlapEnd).toBeGreaterThan(overlapStart);
    }
  });

  it("variant_a and variant_b are siblings under the root, not chained", () => {
    for (const trace of f5ExperimentPipelineTraces) {
      const a = trace.spans.find((s) => s.key === "llm.variant_a");
      const b = trace.spans.find((s) => s.key === "llm.variant_b");
      expect(a!.parentKey).toBe("root");
      expect(b!.parentKey).toBe("root");
    }
  });

  it("eval.compare starts strictly after both variants finish", () => {
    for (const trace of f5ExperimentPipelineTraces) {
      const a = trace.spans.find((s) => s.key === "llm.variant_a")!;
      const b = trace.spans.find((s) => s.key === "llm.variant_b")!;
      const compare = trace.spans.find((s) => s.key === "eval.compare")!;
      expect(compare.startOffsetMs).toBeGreaterThanOrEqual(a.endOffsetMs);
      expect(compare.startOffsetMs).toBeGreaterThanOrEqual(b.endOffsetMs);
    }
  });

  it("at least one instance has variant_b ERROR with a statusMessage", () => {
    const errorVariants = f5ExperimentPipelineTraces.flatMap((t) =>
      t.spans.filter((s) => s.key === "llm.variant_b" && s.status === "ERROR"),
    );
    expect(errorVariants.length).toBeGreaterThanOrEqual(1);
    expect(errorVariants[0].statusMessage).toBeTruthy();
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

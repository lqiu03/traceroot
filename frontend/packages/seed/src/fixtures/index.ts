import type { SeedProject, SeedWorkspace } from "../fixture-types.js";
import { f1AgentRagSuccess } from "./f1-agent-rag-success.js";
import { f2AgentToolFailure } from "./f2-agent-tool-failure.js";
import { f3FailureDetector, type SeedDetector } from "./f3-failure-detector.js";
import { f4SearchRagTraces } from "./f4-search-rag.js";
import { f5ExperimentPipelineTraces } from "./f5-experiment-pipeline.js";

export const SEED_WORKSPACES: readonly SeedWorkspace[] = [
  { slug: "acme", name: "TraceRoot Seed: Acme" },
  { slug: "labs", name: "TraceRoot Seed: Labs" },
];

/**
 * Project list. Default: every project populated with distinct trace shapes —
 * the user-facing fix for "I ran make seed and 2 of 3 projects are empty."
 *
 * Pure function over a passed-in env so tests can exercise the flag-aware
 * branch without mutating `process.env`. The exported `SEED_PROJECTS` is
 * `buildSeedProjects(process.env)` evaluated at module load for consumers
 * that import the const directly.
 */
export function buildSeedProjects(
  env: { readonly SEED_INCLUDE_EMPTY?: string } = {},
): readonly SeedProject[] {
  const includeEmpty = env.SEED_INCLUDE_EMPTY === "true" || env.SEED_INCLUDE_EMPTY === "1";
  return [
    {
      slug: "checkout",
      name: "checkout-agent",
      workspaceSlug: "acme",
      traces: [f1AgentRagSuccess, f2AgentToolFailure],
    },
    {
      slug: "search",
      name: "search-rag",
      workspaceSlug: "acme",
      // SEED_INCLUDE_EMPTY=true preserves the original "empty-state UI
      // exerciser" coverage path. Default ships populated.
      traces: includeEmpty ? [] : f4SearchRagTraces,
    },
    {
      slug: "labs-demo",
      name: "labs-demo",
      workspaceSlug: "labs",
      traces: includeEmpty ? [] : f5ExperimentPipelineTraces,
    },
  ];
}

export const SEED_PROJECTS: readonly SeedProject[] = buildSeedProjects(process.env);

export const SEED_DETECTORS: readonly SeedDetector[] = [f3FailureDetector];

export {
  f1AgentRagSuccess,
  f2AgentToolFailure,
  f3FailureDetector,
  f4SearchRagTraces,
  f5ExperimentPipelineTraces,
};
export type { SeedDetector };

import type { SeedProject, SeedWorkspace } from "../fixture-types.js";
import { f1AgentRagSuccess } from "./f1-agent-rag-success.js";
import { f2AgentToolFailure } from "./f2-agent-tool-failure.js";
import { f3FailureDetector, type SeedDetector } from "./f3-failure-detector.js";

export const SEED_WORKSPACES: readonly SeedWorkspace[] = [
  { slug: "acme", name: "TraceRoot Seed: Acme" },
  { slug: "labs", name: "TraceRoot Seed: Labs" },
];

export const SEED_PROJECTS: readonly SeedProject[] = [
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
    traces: [],
  },
  {
    slug: "labs-demo",
    name: "labs-demo",
    workspaceSlug: "labs",
    traces: [],
  },
];

export const SEED_DETECTORS: readonly SeedDetector[] = [f3FailureDetector];

export { f1AgentRagSuccess, f2AgentToolFailure, f3FailureDetector };
export type { SeedDetector };

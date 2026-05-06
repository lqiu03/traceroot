import { parseArgs } from "node:util";

import { getSeedAnchor, getSeedAnchorDayKey } from "./anchor.js";
import {
  countSeedTraces,
  createClickhouseClient,
  readClickhouseConfig,
} from "./clickhouse-helpers.js";
import { SEED_PROJECTS, SEED_WORKSPACES } from "./fixtures/index.js";
import { ingestProject } from "./otel-exporter.js";
import { ProdGuardError, checkProdGuard } from "./prod-guard.js";
import {
  projectId as derivedProjectId,
  disconnectPrisma,
  resetPrisma,
  seedPrisma,
  validateSeedKeyRoundtrip,
  type SeededProject,
} from "./prisma-seed.js";
import { resetClickhouse } from "./reset.js";

function resolveIngestUrl(env: NodeJS.ProcessEnv): string {
  if (env.SEED_OTLP_ENDPOINT) return env.SEED_OTLP_ENDPOINT;
  const apiBase = env.NEXT_PUBLIC_API_URL?.replace(/\/?$/, "");
  if (apiBase) return `${apiBase}/public/traces`;
  return "http://localhost:8000/api/v1/public/traces";
}

const DEFAULT_INGEST_URL = resolveIngestUrl(process.env);

const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 60_000;

interface CliOptions {
  readonly reset: boolean;
  readonly force: boolean;
  readonly verbose: boolean;
}

function parseCliArgs(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      reset: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      verbose: { type: "boolean", short: "v", default: false },
    },
    allowPositionals: false,
  });
  return {
    reset: Boolean(values.reset),
    force: Boolean(values.force),
    verbose: Boolean(values.verbose),
  };
}

function log(msg: string): void {
  console.log(`[seed] ${msg}`);
}

function warn(msg: string): void {
  console.warn(`[seed] ${msg}`);
}

function error(msg: string): void {
  console.error(`[seed] ${msg}`);
}

async function pollClickhouseUntilSeen(
  projectIds: readonly string[],
  expected: number,
  verbose: boolean,
): Promise<{ seen: number; timedOut: boolean }> {
  const cfg = readClickhouseConfig();
  const client = createClickhouseClient(cfg);
  try {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let seen = 0;
    while (Date.now() < deadline) {
      seen = await countSeedTraces(client, projectIds);
      if (verbose) log(`clickhouse trace rows: ${seen}/${expected}`);
      if (seen >= expected) {
        return { seen, timedOut: false };
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    return { seen, timedOut: true };
  } finally {
    await client.close();
  }
}

async function runReset(opts: CliOptions): Promise<void> {
  log("reset mode: removing seed-prefixed rows");
  // Build the project-id list from fixtures so we don't need a prior seed run.
  const seededProjects: SeededProject[] = SEED_PROJECTS.map((p) => ({
    slug: p.slug,
    id: derivedProjectId(p.slug),
    workspaceId: `seed-ws-${p.workspaceSlug}`,
    apiKey: "",
  }));
  await resetClickhouse({ seededProjects });
  await resetPrisma();
  log("reset complete");
  if (!opts.verbose) return;
  log("(note: ClickHouse mutations are async; rows may linger briefly)");
}

function resolveUiUrl(env: NodeJS.ProcessEnv): string {
  return env.TRACEROOT_UI_URL?.trim() || "http://localhost:3000";
}

/**
 * Verifies the seed-issued API keys validate via web's internal route.
 * Aborts the run with a precise diagnostic if validation fails after
 * retries — preferable to letting OTLP send and silently produce
 * `0/N traces, timed out` 60 seconds later.
 *
 * Skipped (with a warn) if INTERNAL_API_SECRET isn't set, since the
 * validate route requires it.
 */
async function runValidateApiKeyGuard(
  projects: readonly SeededProject[],
  opts: CliOptions,
): Promise<void> {
  if (projects.length === 0) return;
  const internalSecret = process.env.INTERNAL_API_SECRET?.trim();
  if (!internalSecret) {
    warn(
      "INTERNAL_API_SECRET is not set; skipping validate-api-key round-trip guard. " +
        "OTLP ingest may silently fail if web is unreachable.",
    );
    return;
  }
  const uiUrl = resolveUiUrl(process.env);
  const probe = projects[0];
  const result = await validateSeedKeyRoundtrip(probe, { uiUrl, internalSecret });
  if (!result.ok) {
    throw new Error(
      `seed key for ${probe.id} failed validate-api-key round-trip: ${result.error}\n` +
        `  troubleshooting:\n` +
        `    - Is the 'web' container/process up at ${uiUrl}? (try \`curl -s ${uiUrl}\`)\n` +
        `    - Is INTERNAL_API_SECRET set the same in seed and web environments?\n` +
        `    - Did the seed's secretHash write to access_keys table successfully?\n` +
        `    - Run again with --verbose for poll detail.`,
    );
  }
  if (opts.verbose) {
    log(
      `auth roundtrip ok: ${probe.id} validated via ${uiUrl}/api/internal/validate-api-key ` +
        `(${result.attempts} attempt${result.attempts > 1 ? "s" : ""})`,
    );
  }
}

async function runSeed(opts: CliOptions): Promise<void> {
  const start = Date.now();
  log(`endpoint: ${DEFAULT_INGEST_URL}`);
  log(`anchor day: ${getSeedAnchorDayKey()} (UTC)`);

  const { workspaces, projects } = await seedPrisma(SEED_WORKSPACES, SEED_PROJECTS);
  log(`prisma: ${workspaces.length} workspaces, ${projects.length} projects ready`);

  // Runtime guard: round-trip the first seed key through the same
  // /api/internal/validate-api-key route that rest's OTLP ingest uses.
  // Catches the cold-start race that today surfaced as `0/N traces, timed
  // out` 60s later, plus any hash/secret/lookup-field drift in the future.
  await runValidateApiKeyGuard(projects, opts);

  const anchor = getSeedAnchor();
  const fixtureBySlug = new Map(SEED_PROJECTS.map((p) => [p.slug, p]));

  let totalTraces = 0;
  let totalSpans = 0;
  for (const seeded of projects) {
    const fixture = fixtureBySlug.get(seeded.slug);
    if (!fixture) continue;
    const result = await ingestProject({
      project: fixture,
      seeded,
      anchor,
      endpointUrl: DEFAULT_INGEST_URL,
    });
    totalTraces += result.tracesEmitted;
    totalSpans += result.spansEmitted;
    if (opts.verbose) {
      log(`${seeded.slug}: ${result.tracesEmitted} traces, ${result.spansEmitted} spans`);
    }
  }
  log(`otel: emitted ${totalTraces} traces, ${totalSpans} spans`);

  if (totalTraces > 0) {
    log("waiting for clickhouse to ingest…");
    const projectIds = projects
      .filter((p) => fixtureBySlug.get(p.slug)?.traces.length)
      .map((p) => p.id);
    const { seen, timedOut } = await pollClickhouseUntilSeen(projectIds, totalTraces, opts.verbose);
    if (timedOut) {
      warn(
        `timed out after ${POLL_TIMEOUT_MS}ms — saw ${seen}/${totalTraces} traces. ` +
          `Is the Celery worker running? Check the 'worker' tmux pane or container logs.`,
      );
    } else {
      log(`clickhouse: ${seen} trace rows visible`);
    }
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  log(`done in ${elapsed}s`);
  log("explore: http://localhost:3000/workspaces");
  for (const project of projects) {
    const fixture = fixtureBySlug.get(project.slug);
    const tag = fixture?.traces.length ? "(seeded)" : "(empty — exercises empty-state UI)";
    log(`  - ${project.id} ${tag}`);
  }
}

async function main(): Promise<void> {
  const opts = parseCliArgs(process.argv.slice(2));

  try {
    checkProdGuard(process.env);
  } catch (e) {
    if (e instanceof ProdGuardError) {
      if (opts.force) {
        warn(`override: ${e.message}`);
      } else {
        error(e.message);
        process.exitCode = 2;
        return;
      }
    } else {
      throw e;
    }
  }

  try {
    if (opts.reset) {
      await runReset(opts);
    } else {
      await runSeed(opts);
    }
  } finally {
    await disconnectPrisma();
  }
}

main().catch((e: unknown) => {
  console.error("[seed] fatal:", e);
  process.exitCode = 1;
});

import type { ClickHouseClient } from "@clickhouse/client";
import type { PrismaClient } from "@prisma/client";

import { deterministicHex } from "./crypto-utils.js";
import { SEED_FINDING_PHRASES } from "./fixtures/f3-failure-detector.js";

/**
 * The structural fix from session: re-runs of the seed must converge over
 * current Postgres state, not replay fixture intent. This module is the
 * single write path for `detector_runs` + `detector_findings`. It treats
 * synthetic detectors (inserted by `seedDetectors` in prisma-seed.ts as
 * Postgres rows) and UI-created detectors in seed-owned workspaces
 * uniformly: both are discovered via the same query, both get backfilled
 * with deterministic outputs, both are scoped by the same `is_seed`
 * predicate.
 *
 * Idempotency: every run_id and finding_id is derived deterministically
 * from `(detector_id, slot)`. Re-runs DELETE seed-prefixed rows scoped to
 * discovered detectors, then INSERT — correct regardless of the
 * ReplacingMergeTree ORDER BY.
 */

export interface SeedDetectorOutputsOptions {
  /** Number of detector_runs to generate per detector. */
  readonly runsPerDetector: number;
  /**
   * Fraction in [0,1] of runs that produce a finding. Each generated run
   * picks deterministically based on its slot index.
   */
  readonly findingRate: number;
  /**
   * Trace ids the detector "ran against." Required so referenced traces
   * exist in ClickHouse. The discovery pass picks at most `runsPerDetector`
   * via deterministic round-robin.
   */
  readonly traceIdsByProject: ReadonlyMap<string, readonly string[]>;
  /** Anchor timestamp for spreading runs over a 24h window. */
  readonly anchor: Date;
  /** ClickHouse table prefix override for tests; defaults to none. */
  readonly tableNamespace?: string;
}

export interface DiscoveredDetector {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
}

/**
 * Selects detectors that the seed is allowed to backfill. Predicate is
 * `detector.is_seed = TRUE OR project.workspace.is_seed = TRUE` —
 * the OR covers UI-created detectors inside a seed workspace whose own
 * is_seed flag wasn't set at creation time. Scoped by workspace
 * ownership; never touches a detector outside seed-owned workspaces.
 */
export async function discoverSeedDetectors(
  prisma: PrismaClient,
): Promise<readonly DiscoveredDetector[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (await (prisma as any).$queryRawUnsafe(
    `SELECT d.id, d.project_id AS "projectId", d.name
     FROM detectors d
     JOIN projects p ON p.id = d.project_id
     JOIN workspaces w ON w.id = p.workspace_id
     WHERE COALESCE(d.is_seed, FALSE) = TRUE OR COALESCE(w.is_seed, FALSE) = TRUE
     ORDER BY d.id`,
  )) as DiscoveredDetector[];
  return rows;
}

/** Stable run id from (detectorId, slot). */
export function deterministicRunId(detectorId: string, slot: number): string {
  return `seed-run-${detectorId}-${deterministicHex(`${detectorId}:${slot}`, 12)}`;
}

/** Stable finding id from (detectorId, slot). */
export function deterministicFindingId(detectorId: string, slot: number): string {
  return `seed-find-${detectorId}-${deterministicHex(`${detectorId}:${slot}`, 12)}`;
}

/** Picks a deterministic phrase for slot N. */
export function findingSummaryForSlot(slot: number): string {
  return SEED_FINDING_PHRASES[slot % SEED_FINDING_PHRASES.length];
}

/** Picks a deterministic severity for slot N. */
export function severityForSlot(slot: number): "low" | "medium" | "high" | "critical" {
  return (["low", "medium", "high", "critical"] as const)[slot % 4];
}

/**
 * Discovers all seed-scoped detectors and writes deterministic
 * detector_runs + detector_findings against them. Idempotent: every run
 * cleans seed-prefixed rows for the discovered detectors before INSERT.
 */
export async function seedDetectorOutputs(
  prisma: PrismaClient,
  ch: ClickHouseClient,
  opts: SeedDetectorOutputsOptions,
): Promise<{ readonly detectors: number; readonly runs: number; readonly findings: number }> {
  const detectors = await discoverSeedDetectors(prisma);
  if (detectors.length === 0) return { detectors: 0, runs: 0, findings: 0 };

  const ns = opts.tableNamespace ? `${opts.tableNamespace}.` : "";
  const runsTable = `${ns}detector_runs`;
  const findingsTable = `${ns}detector_findings`;

  // Scope-safe cleanup: only seed-prefixed run/finding ids for the discovered
  // detectors. Never touches user-created (non-seed) outputs.
  const detectorIds = detectors.map((d) => d.id);
  await ch.command({
    query:
      `ALTER TABLE ${runsTable} DELETE ` +
      `WHERE detector_id IN ({ids:Array(String)}) AND startsWith(run_id, 'seed-run-')`,
    query_params: { ids: detectorIds },
  });
  await ch.command({
    query:
      `ALTER TABLE ${findingsTable} DELETE ` +
      `WHERE startsWith(finding_id, 'seed-find-') AND project_id IN ({pids:Array(String)})`,
    query_params: { pids: Array.from(new Set(detectors.map((d) => d.projectId))) },
  });

  // Build INSERT payloads.
  const runRows: Array<Record<string, unknown>> = [];
  const findingRows: Array<Record<string, unknown>> = [];
  let totalRuns = 0;
  let totalFindings = 0;

  for (const det of detectors) {
    const traceIds = opts.traceIdsByProject.get(det.projectId);
    if (!traceIds || traceIds.length === 0) continue;
    for (let slot = 0; slot < opts.runsPerDetector; slot++) {
      const runId = deterministicRunId(det.id, slot);
      const traceId = traceIds[slot % traceIds.length];
      // Spread runs evenly across a 24h window before `anchor`.
      const ts = new Date(opts.anchor.getTime() - slot * 17 * 60 * 1000);
      const tsIso = ts.toISOString().replace("T", " ").replace("Z", "");
      // Determine if this slot produces a finding using a stable hash.
      const hashByte = Number.parseInt(deterministicHex(`finding:${det.id}:${slot}`, 2), 16);
      const hasFinding = hashByte / 255 < opts.findingRate;
      let findingId: string | null = null;
      if (hasFinding) {
        findingId = deterministicFindingId(det.id, slot);
        findingRows.push({
          finding_id: findingId,
          project_id: det.projectId,
          trace_id: traceId,
          summary: findingSummaryForSlot(slot),
          payload: JSON.stringify({
            detector: det.name,
            severity: severityForSlot(slot),
            slot,
          }),
          timestamp: tsIso,
        });
        totalFindings += 1;
      }
      runRows.push({
        run_id: runId,
        detector_id: det.id,
        project_id: det.projectId,
        trace_id: traceId,
        finding_id: findingId,
        status: "completed",
        timestamp: tsIso,
      });
      totalRuns += 1;
    }
  }

  if (runRows.length > 0) {
    await ch.insert({
      table: `${ns}detector_runs`,
      values: runRows,
      format: "JSONEachRow",
    });
  }
  if (findingRows.length > 0) {
    await ch.insert({
      table: `${ns}detector_findings`,
      values: findingRows,
      format: "JSONEachRow",
    });
  }

  return { detectors: detectors.length, runs: totalRuns, findings: totalFindings };
}

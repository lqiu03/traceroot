import type { ClickHouseClient } from "@clickhouse/client";
import {
  createClickhouseClient,
  readClickhouseConfig,
  type ClickhouseConfig,
} from "./clickhouse-helpers.js";
import type { SeededProject } from "./prisma-seed.js";

const TABLES_WITH_PROJECT_AND_TRACE_ID = ["traces", "spans"] as const;
const MUTATION_POLL_INTERVAL_MS = 250;
const MUTATION_TIMEOUT_MS = 30_000;

/**
 * Builds the SQL string used by `--reset` for a given table. Exposed for
 * tests to assert the predicate is exactly seed-scoped.
 */
export function buildClickhouseDeleteSql(
  table: "traces" | "spans",
  projectIds: readonly string[],
): { readonly sql: string; readonly params: Record<string, string> } {
  if (projectIds.length === 0) {
    throw new Error(`[seed] refusing to issue empty DELETE on ${table}`);
  }
  const placeholders = projectIds.map((_, i) => `{p${i}:String}`).join(", ");
  const params: Record<string, string> = {};
  projectIds.forEach((id, i) => {
    params[`p${i}`] = id;
  });
  // Predicate scoped purely on project_id: seed projects are seed-prefixed,
  // and seed-only ingestion guarantees no real customer rows share these ids.
  // (Trace IDs are 32-hex SHA-256 derivations, not seed-prefixed strings.)
  const sql = `ALTER TABLE ${table} DELETE WHERE project_id IN (${placeholders})`;
  return { sql, params };
}

async function waitForMutations(client: ClickHouseClient): Promise<void> {
  const deadline = Date.now() + MUTATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const rs = await client.query({
      query: `SELECT count() AS c FROM system.mutations WHERE is_done = 0 AND table IN ('traces', 'spans', 'detector_runs', 'detector_findings')`,
      format: "JSONEachRow",
    });
    const rows = (await rs.json()) as Array<{ c: string | number }>;
    const pending = rows.length === 0 ? 0 : Number(rows[0].c);
    if (pending === 0) return;
    await new Promise((r) => setTimeout(r, MUTATION_POLL_INTERVAL_MS));
  }
  // Non-fatal: mutations may still be running on a slow machine. The CLI
  // surfaces this as a warning rather than a hard error so `--reset` always
  // returns control to the caller.
}

interface ResetArgs {
  readonly seededProjects: readonly SeededProject[];
  readonly clickhouseConfig?: ClickhouseConfig;
  readonly clickhouseClient?: ClickHouseClient;
}

export async function resetClickhouse(
  args: Pick<ResetArgs, "seededProjects" | "clickhouseConfig" | "clickhouseClient">,
): Promise<void> {
  const projectIds = args.seededProjects.map((p) => p.id);
  if (projectIds.length === 0) return;

  const ownsClient = !args.clickhouseClient;
  const cfg = args.clickhouseConfig ?? readClickhouseConfig();
  const client = args.clickhouseClient ?? createClickhouseClient(cfg);

  try {
    for (const table of TABLES_WITH_PROJECT_AND_TRACE_ID) {
      const { sql, params } = buildClickhouseDeleteSql(table, projectIds);
      await client.command({ query: sql, query_params: params });
    }
    // Detector output tables: scoped by seed-id-prefix on the natural key
    // AND seed project_id, so we never touch a UI-created row that happens
    // to land in a seed project.
    await client.command({
      query:
        `ALTER TABLE detector_runs DELETE ` +
        `WHERE startsWith(run_id, 'seed-run-') AND project_id IN ({pids:Array(String)})`,
      query_params: { pids: projectIds },
    });
    await client.command({
      query:
        `ALTER TABLE detector_findings DELETE ` +
        `WHERE startsWith(finding_id, 'seed-find-') AND project_id IN ({pids:Array(String)})`,
      query_params: { pids: projectIds },
    });
    await waitForMutations(client);
  } finally {
    if (ownsClient) {
      await client.close();
    }
  }
}

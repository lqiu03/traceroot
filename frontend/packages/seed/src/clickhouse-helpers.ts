import { createClient, type ClickHouseClient } from "@clickhouse/client";

export interface ClickhouseConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
}

export function readClickhouseConfig(env: NodeJS.ProcessEnv = process.env): ClickhouseConfig {
  return {
    host: env.CLICKHOUSE_HOST ?? "localhost",
    port: Number(env.CLICKHOUSE_PORT ?? 8123),
    user: env.CLICKHOUSE_USER ?? "clickhouse",
    password: env.CLICKHOUSE_PASSWORD ?? "clickhouse",
    database: env.CLICKHOUSE_DATABASE ?? "default",
  };
}

export function buildClickhouseUrl(cfg: ClickhouseConfig): string {
  // Force IPv4: Node prefers `::1` for `localhost`, but Docker's ClickHouse
  // binds to `127.0.0.1:8123` only — using the literal v4 address avoids
  // ECONNREFUSED when running the seed from the host against a containerized
  // stack.
  const host = cfg.host === "localhost" ? "127.0.0.1" : cfg.host;
  return `http://${host}:${cfg.port}`;
}

export function createClickhouseClient(cfg: ClickhouseConfig): ClickHouseClient {
  return createClient({
    url: buildClickhouseUrl(cfg),
    username: cfg.user,
    password: cfg.password,
    database: cfg.database,
  });
}

/** Count rows in `traces` for the given project ids — the readiness probe. */
export async function countSeedTraces(
  client: ClickHouseClient,
  projectIds: readonly string[],
): Promise<number> {
  if (projectIds.length === 0) return 0;
  const placeholders = projectIds.map((_, i) => `{p${i}:String}`).join(", ");
  const params: Record<string, string> = {};
  projectIds.forEach((id, i) => {
    params[`p${i}`] = id;
  });
  const rs = await client.query({
    query: `SELECT count() AS c FROM traces FINAL WHERE project_id IN (${placeholders})`,
    query_params: params,
    format: "JSONEachRow",
  });
  const rows = (await rs.json()) as Array<{ c: string | number }>;
  return rows.length === 0 ? 0 : Number(rows[0].c);
}

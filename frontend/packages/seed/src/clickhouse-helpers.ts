import * as net from "node:net";

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

/**
 * Per-project trace counts. Used for the end-of-run summary so labels are
 * derived from measured ClickHouse state rather than asserted from fixture
 * intent (honesty-of-output).
 */
export async function countSeedTracesByProject(
  client: ClickHouseClient,
  projectIds: readonly string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>(projectIds.map((id) => [id, 0]));
  if (projectIds.length === 0) return out;
  const placeholders = projectIds.map((_, i) => `{p${i}:String}`).join(", ");
  const params: Record<string, string> = {};
  projectIds.forEach((id, i) => {
    params[`p${i}`] = id;
  });
  const rs = await client.query({
    query:
      `SELECT project_id, count() AS c FROM traces FINAL ` +
      `WHERE project_id IN (${placeholders}) GROUP BY project_id`,
    query_params: params,
    format: "JSONEachRow",
  });
  const rows = (await rs.json()) as Array<{ project_id: string; c: string | number }>;
  for (const row of rows) out.set(row.project_id, Number(row.c));
  return out;
}

/** Parsed `redis://[user[:pass]@]host[:port][/db]` URL. */
export interface RedisUrlParts {
  readonly host: string;
  readonly port: number;
  readonly db: number;
  readonly password?: string;
}

export function parseRedisUrl(url: string): RedisUrlParts {
  const u = new URL(url);
  if (u.protocol !== "redis:" && u.protocol !== "rediss:") {
    throw new Error(`unsupported redis url protocol: ${u.protocol}`);
  }
  const dbStr = u.pathname.replace(/^\//, "");
  const db = dbStr === "" ? 0 : Number(dbStr);
  return {
    host: u.hostname === "localhost" ? "127.0.0.1" : u.hostname || "127.0.0.1",
    port: u.port === "" ? 6379 : Number(u.port),
    db: Number.isFinite(db) ? db : 0,
    password: u.password || undefined,
  };
}

/**
 * Returns `LLEN <queueName>` from a Redis broker, or `"unknown"` on any
 * connection / parse / timeout error. Used to distinguish "still draining"
 * from "rejected/dropped" at seed-poll exit. Minimal raw RESP — no new
 * dependency for what is essentially one round-trip per seed run.
 */
export async function getCeleryQueueDepth(
  redisUrl: string,
  queueName: string = "celery",
  timeoutMs: number = 1500,
): Promise<number | "unknown"> {
  let parts: RedisUrlParts;
  try {
    parts = parseRedisUrl(redisUrl);
  } catch {
    return "unknown";
  }
  return new Promise<number | "unknown">((resolve) => {
    const sock = net.createConnection({ host: parts.host, port: parts.port });
    let buf = Buffer.alloc(0);
    let phase: "auth" | "select" | "llen" = parts.password ? "auth" : parts.db ? "select" : "llen";
    let resolved = false;
    const finish = (v: number | "unknown"): void => {
      if (resolved) return;
      resolved = true;
      sock.end();
      sock.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => finish("unknown"), timeoutMs);
    const respCmd = (...args: string[]): Buffer => {
      const lines = [`*${args.length}`];
      for (const a of args) lines.push(`$${Buffer.byteLength(a)}`, a);
      return Buffer.from(lines.join("\r\n") + "\r\n");
    };
    sock.once("error", () => finish("unknown"));
    sock.once("connect", () => {
      if (parts.password) sock.write(respCmd("AUTH", parts.password));
      else if (parts.db) sock.write(respCmd("SELECT", String(parts.db)));
      else sock.write(respCmd("LLEN", queueName));
    });
    sock.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      // walk responses one by one; we expect at most 3
      let i: number;
      while ((i = buf.indexOf("\r\n")) !== -1) {
        const line = buf.slice(0, i).toString("utf8");
        buf = buf.slice(i + 2);
        if (phase === "auth") {
          if (!line.startsWith("+")) return finish("unknown");
          if (parts.db) {
            phase = "select";
            sock.write(respCmd("SELECT", String(parts.db)));
          } else {
            phase = "llen";
            sock.write(respCmd("LLEN", queueName));
          }
        } else if (phase === "select") {
          if (!line.startsWith("+")) return finish("unknown");
          phase = "llen";
          sock.write(respCmd("LLEN", queueName));
        } else if (phase === "llen") {
          clearTimeout(timer);
          if (!line.startsWith(":")) return finish("unknown");
          const n = Number(line.slice(1));
          return finish(Number.isFinite(n) && n >= 0 ? n : "unknown");
        }
      }
    });
  });
}

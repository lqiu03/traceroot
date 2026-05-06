/**
 * Refuses to run the seeder against anything that looks like production.
 * Three independent checks; any one trip → error.
 *
 * Bypassed only by `--force` flag (with stderr warning), which the CLI
 * exposes for self-hosted-but-not-localhost dev cases (e.g. a remote dev box).
 */

const LOCAL_CLICKHOUSE_HOSTS = new Set(["localhost", "127.0.0.1", "clickhouse", ""]);

const LOCAL_DB_MARKERS = ["localhost", "127.0.0.1", "@postgres"];

export class ProdGuardError extends Error {
  constructor(reason: string) {
    super(`[seed] refusing to run: ${reason}. Pass --force to override.`);
    this.name = "ProdGuardError";
  }
}

export interface ProdGuardEnv {
  TRACEROOT_ENV?: string;
  NODE_ENV?: string;
  CLICKHOUSE_HOST?: string;
  DATABASE_URL?: string;
}

/** Summary of what `checkProdGuard` observed when allowing the run. */
export interface ProdGuardSummary {
  readonly chHost: string;
  readonly nodeEnv: string;
  readonly trEnv: string;
  readonly dbHostMarker: string;
}

/**
 * One-line, log-friendly description of which env signals the guard
 * accepted. Honesty-of-output rule: report what was observed, not silence.
 */
export function summarizeProdGuard(s: ProdGuardSummary): string {
  return (
    `chHost=${s.chHost || "(unset)"} ` +
    `nodeEnv=${s.nodeEnv || "(unset)"} ` +
    `trEnv=${s.trEnv || "(unset)"} ` +
    `dbHost=${s.dbHostMarker}`
  );
}

export function checkProdGuard(env: ProdGuardEnv): ProdGuardSummary {
  const trEnv = (env.TRACEROOT_ENV ?? "").toLowerCase();
  if (trEnv === "prod" || trEnv === "production") {
    throw new ProdGuardError(`TRACEROOT_ENV=${env.TRACEROOT_ENV}`);
  }

  const nodeEnv = (env.NODE_ENV ?? "").toLowerCase();
  if (nodeEnv === "production") {
    throw new ProdGuardError(`NODE_ENV=${env.NODE_ENV}`);
  }

  const chHost = (env.CLICKHOUSE_HOST ?? "").toLowerCase();
  if (!LOCAL_CLICKHOUSE_HOSTS.has(chHost)) {
    throw new ProdGuardError(
      `CLICKHOUSE_HOST=${env.CLICKHOUSE_HOST} is not a recognized local host`,
    );
  }

  const dbUrl = env.DATABASE_URL ?? "";
  if (dbUrl && !LOCAL_DB_MARKERS.some((m) => dbUrl.includes(m))) {
    throw new ProdGuardError(
      `DATABASE_URL does not look local (no localhost/127.0.0.1/@postgres marker)`,
    );
  }
  const matchedMarker = LOCAL_DB_MARKERS.find((m) => dbUrl.includes(m)) ?? "(no DATABASE_URL set)";

  return { chHost, nodeEnv, trEnv, dbHostMarker: matchedMarker };
}

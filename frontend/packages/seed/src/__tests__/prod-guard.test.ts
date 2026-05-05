import { describe, expect, it } from "vitest";

import { ProdGuardError, checkProdGuard } from "../prod-guard.js";

const localBaseline = {
  CLICKHOUSE_HOST: "localhost",
  DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/postgres",
};

describe("checkProdGuard", () => {
  it("passes for the standard local dev environment", () => {
    expect(() => checkProdGuard(localBaseline)).not.toThrow();
  });

  it("passes for docker-compose internal hostname 'clickhouse'", () => {
    expect(() => checkProdGuard({ ...localBaseline, CLICKHOUSE_HOST: "clickhouse" })).not.toThrow();
  });

  it("rejects TRACEROOT_ENV=prod", () => {
    expect(() => checkProdGuard({ ...localBaseline, TRACEROOT_ENV: "prod" })).toThrow(
      ProdGuardError,
    );
  });

  it("rejects NODE_ENV=production", () => {
    expect(() => checkProdGuard({ ...localBaseline, NODE_ENV: "production" })).toThrow(
      ProdGuardError,
    );
  });

  it("rejects a non-local CLICKHOUSE_HOST", () => {
    expect(() => checkProdGuard({ ...localBaseline, CLICKHOUSE_HOST: "ch.prod.internal" })).toThrow(
      ProdGuardError,
    );
  });

  it("rejects a remote DATABASE_URL", () => {
    expect(() =>
      checkProdGuard({
        ...localBaseline,
        DATABASE_URL: "postgresql://user:pass@db.prod.internal:5432/traceroot",
      }),
    ).toThrow(ProdGuardError);
  });
});

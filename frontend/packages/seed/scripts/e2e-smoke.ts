#!/usr/bin/env tsx
/**
 * End-to-end smoke for `make seed`. Assumes a local stack is up; reset →
 * seed → assert. Designed for CI: exit 0 on green, exit 1 with a precise
 * message on any regression. Run with `pnpm --filter @traceroot/seed test:e2e`.
 *
 * Why this exists: today's session surfaced #1 (auth roundtrip broken)
 * silently — the seed reported "0/N traces, timed out" 60s in. A smoke
 * test that runs through the full path on every PR catches that class of
 * regression before review.
 */
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  countSeedTraces,
  countSeedTracesByProject,
  createClickhouseClient,
  readClickhouseConfig,
} from "../src/clickhouse-helpers.js";
import { SEED_PROJECTS } from "../src/fixtures/index.js";
import { projectId } from "../src/prisma-seed.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, "..");

interface AssertResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

async function runPnpmScript(target: "seed" | "seed:reset"): Promise<void> {
  return new Promise((resolveExec, rejectExec) => {
    const child = spawn("pnpm", ["run", target], {
      cwd: PKG,
      stdio: "inherit",
      env: process.env,
    });
    child.once("error", rejectExec);
    child.once("exit", (code) => {
      if (code === 0) resolveExec();
      else rejectExec(new Error(`pnpm ${target} exited with code ${code}`));
    });
  });
}

async function assertCount(
  name: string,
  query: string,
  predicate: (n: number) => boolean,
): Promise<AssertResult> {
  const cfg = readClickhouseConfig();
  const ch = createClickhouseClient(cfg);
  try {
    const rs = await ch.query({ query, format: "JSONEachRow" });
    const rows = (await rs.json()) as Array<{ c: string | number }>;
    const n = rows.length === 0 ? 0 : Number(rows[0].c);
    return { name, ok: predicate(n), detail: `count=${n}` };
  } finally {
    await ch.close();
  }
}

async function main(): Promise<void> {
  console.log("[e2e] reset → seed → assert");

  await runPnpmScript("seed:reset");
  await runPnpmScript("seed");

  // Pull project ids from fixtures so this stays in sync if fixtures change.
  const seedProjectIds = SEED_PROJECTS.map((p) => projectId(p.slug));
  const seedProjectFixturesWithTraces = SEED_PROJECTS.filter((p) => p.traces.length > 0).map((p) =>
    projectId(p.slug),
  );

  const cfg = readClickhouseConfig();
  const ch = createClickhouseClient(cfg);
  try {
    const totalTraces = await countSeedTraces(ch, seedProjectIds);
    const byProject = await countSeedTracesByProject(ch, seedProjectIds);
    console.log(`[e2e] traces total = ${totalTraces}`);
    for (const [pid, n] of byProject) console.log(`[e2e]   ${pid}: ${n}`);

    const results: AssertResult[] = [];

    // 1. Each fixture-traced project must have a non-zero count post-seed.
    for (const pid of seedProjectFixturesWithTraces) {
      const n = byProject.get(pid) ?? 0;
      results.push({ name: `traces[${pid}] > 0`, ok: n > 0, detail: `count=${n}` });
    }

    // 2. Detector outputs should exist (seed has at least one fixture detector).
    results.push(
      await assertCount(
        "detector_runs (seed-prefixed) > 0",
        "SELECT count() AS c FROM detector_runs WHERE startsWith(run_id, 'seed-run-')",
        (n) => n > 0,
      ),
    );
    results.push(
      await assertCount(
        "detector_findings (seed-prefixed) > 0",
        "SELECT count() AS c FROM detector_findings WHERE startsWith(finding_id, 'seed-find-')",
        (n) => n > 0,
      ),
    );

    let failed = 0;
    for (const r of results) {
      const tag = r.ok ? "ok" : "FAIL";
      console.log(`[e2e] ${tag}  ${r.name} — ${r.detail}`);
      if (!r.ok) failed += 1;
    }
    if (failed > 0) {
      console.error(`[e2e] FAIL: ${failed}/${results.length} assertions failed`);
      process.exitCode = 1;
      return;
    }
    console.log(`[e2e] OK: ${results.length}/${results.length} assertions passed`);
  } finally {
    await ch.close();
  }
}

main().catch((err: unknown) => {
  console.error("[e2e] fatal:", err);
  process.exitCode = 1;
});

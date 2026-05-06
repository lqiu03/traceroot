import { PrismaClient } from "@prisma/client";

import { deterministicHex, deterministicSeedApiKey, keyHint, sha256Hex } from "./crypto-utils.js";
import type { SeedProject, SeedWorkspace } from "./fixture-types.js";
import type { SeedDetector } from "./fixtures/f3-failure-detector.js";

/**
 * Local PrismaClient instead of the `@traceroot/core` singleton: tsx on
 * Node 18 cannot resolve named ESM exports through a CJS workspace package
 * whose `main` points at a `.ts` file. Direct instantiation keeps the seed
 * runtime self-contained and avoids cross-workspace module-format friction.
 */
let _prisma: PrismaClient | null = null;

function getPrisma(): PrismaClient {
  if (!_prisma) {
    _prisma = new PrismaClient({ log: ["error", "warn"] });
  }
  return _prisma;
}

export async function disconnectPrisma(): Promise<void> {
  if (_prisma) {
    await _prisma.$disconnect();
    _prisma = null;
  }
}

const SEED_DEMO_USER_EMAIL = "seed-demo@example.com";
const SEED_DEMO_USER_NAME = "Seed Demo (auto-generated)";

export interface SeededProject {
  readonly slug: string;
  readonly id: string;
  readonly workspaceId: string;
  readonly apiKey: string;
}

export interface SeededWorkspace {
  readonly slug: string;
  readonly id: string;
}

export interface SeedPrismaResult {
  readonly workspaces: readonly SeededWorkspace[];
  readonly projects: readonly SeededProject[];
  readonly demoUserId: string;
}

export function workspaceId(slug: string): string {
  return `seed-ws-${slug}`;
}

export function projectId(slug: string): string {
  return `seed-prj-${slug}`;
}

function workspaceMemberId(workspaceSlug: string, userId: string): string {
  return `seed-wm-${deterministicHex(`wm:${workspaceSlug}:${userId}`, 24)}`;
}

function accessKeyId(projectSlug: string): string {
  return `seed-ak-${projectSlug}`;
}

function seedDemoUserId(): string {
  return `seed-user-demo`;
}

/**
 * Seeds Prisma rows for the given workspaces and projects. Idempotent:
 * second call produces no diff.
 *
 * If `process.env.SEED_ATTACH_USER_EMAIL` is set, the existing user with
 * that email (matched on the unique `email` column) is also added as ADMIN
 * of each seeded workspace. This lets the contributor's logged-in account
 * see seed data without re-login.
 */
export async function seedPrisma(
  workspaces: readonly SeedWorkspace[],
  projects: readonly SeedProject[],
): Promise<SeedPrismaResult> {
  const demoUserId = seedDemoUserId();

  await getPrisma().user.upsert({
    where: { id: demoUserId },
    update: {
      email: SEED_DEMO_USER_EMAIL,
      name: SEED_DEMO_USER_NAME,
    },
    create: {
      id: demoUserId,
      email: SEED_DEMO_USER_EMAIL,
      emailVerified: true,
      name: SEED_DEMO_USER_NAME,
    },
  });

  const attachEmail = process.env.SEED_ATTACH_USER_EMAIL?.trim();
  let attachUserId: string | null = null;
  if (attachEmail) {
    const existing = await getPrisma().user.findUnique({ where: { email: attachEmail } });
    if (existing) {
      attachUserId = existing.id;
    } else {
      // Soft-warn; not a hard failure — the seed should still succeed.

      console.warn(
        `[seed] SEED_ATTACH_USER_EMAIL=${attachEmail} not found; only demo user will be attached.`,
      );
    }
  }

  const seededWorkspaces: SeededWorkspace[] = [];
  for (const ws of workspaces) {
    const id = workspaceId(ws.slug);
    await getPrisma().workspace.upsert({
      where: { id },
      // Defensively set isSeed=true on update too — covers the case where a
      // workspace was created before the is_seed migration landed.
      update: { name: ws.name, isSeed: true },
      create: {
        id,
        name: ws.name,
        billingPlan: "free",
        ingestionBlocked: false,
        aiBlocked: false,
        isSeed: true,
      },
    });

    const memberIds = [demoUserId, ...(attachUserId ? [attachUserId] : [])];
    for (const userId of memberIds) {
      const wmId = workspaceMemberId(ws.slug, userId);
      await getPrisma().workspaceMember.upsert({
        where: {
          workspaceId_userId: { workspaceId: id, userId },
        },
        update: { role: "ADMIN" },
        create: {
          id: wmId,
          workspaceId: id,
          userId,
          role: "ADMIN",
        },
      });
    }

    seededWorkspaces.push({ slug: ws.slug, id });
  }

  const seededProjects: SeededProject[] = [];
  for (const project of projects) {
    const id = projectId(project.slug);
    const wsId = workspaceId(project.workspaceSlug);

    await getPrisma().project.upsert({
      where: { id },
      update: { name: project.name, workspaceId: wsId },
      create: {
        id,
        name: project.name,
        workspaceId: wsId,
      },
    });

    const apiKey = deterministicSeedApiKey(project.slug);
    const secretHash = sha256Hex(apiKey);
    const akId = accessKeyId(project.slug);

    await getPrisma().accessKey.upsert({
      where: { id: akId },
      update: {
        projectId: id,
        secretHash,
        keyHint: keyHint(apiKey),
        name: "seed-default",
      },
      create: {
        id: akId,
        projectId: id,
        secretHash,
        keyHint: keyHint(apiKey),
        name: "seed-default",
      },
    });

    seededProjects.push({ slug: project.slug, id, workspaceId: wsId, apiKey });
  }

  return {
    workspaces: seededWorkspaces,
    projects: seededProjects,
    demoUserId,
  };
}

/**
 * Upserts synthetic detector rows (Postgres) via raw SQL — the Detector
 * model isn't in our local Prisma schema (the upstream migration that
 * adds it lives on a different branch), but the table exists at runtime
 * and we don't need the typed client to insert deterministic test rows.
 *
 * Sets is_seed=true so the discovery pass (and reset) can scope to these
 * regardless of which prefix the id ends up using.
 */
export async function seedDetectors(detectors: readonly SeedDetector[]): Promise<void> {
  if (detectors.length === 0) return;
  for (const d of detectors) {
    // Postgres path. UPDATE-then-INSERT keeps idempotency under re-runs and
    // avoids depending on a typed Detector model that we don't ship here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prismaAny = getPrisma() as any;
    await prismaAny.$executeRawUnsafe(
      `INSERT INTO detectors (
         id, project_id, name, template, prompt, output_schema,
         sample_rate, enabled, create_time, update_time, is_seed
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, NOW(), NOW(), TRUE)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         template = EXCLUDED.template,
         prompt = EXCLUDED.prompt,
         output_schema = EXCLUDED.output_schema,
         sample_rate = EXCLUDED.sample_rate,
         is_seed = TRUE,
         update_time = NOW()`,
      d.id,
      d.projectId,
      d.name,
      d.template,
      d.prompt,
      JSON.stringify(d.outputSchema),
      d.sampleRate,
      true,
    );
  }
}

/** Removes all seed-prefixed Prisma rows. Cascades through Project → AccessKey. */
export async function resetPrisma(): Promise<void> {
  // Delete is_seed-flagged detectors first (cascade handles their FK refs).
  // Falls back gracefully if the is_seed column is missing on older DBs.
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (getPrisma() as any).$executeRawUnsafe(
      `DELETE FROM detectors WHERE is_seed = TRUE`,
    );
  } catch {
    // is_seed column not present yet — fall back to id prefix
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (getPrisma() as any).$executeRawUnsafe(
      `DELETE FROM detectors WHERE id LIKE 'seed-det-%'`,
    );
  }
  // Delete by id prefix; cascade does Project, AccessKey, WorkspaceMember.
  await getPrisma().workspace.deleteMany({
    where: { id: { startsWith: "seed-ws-" } },
  });
  await getPrisma().user.deleteMany({
    where: { id: { startsWith: "seed-user-" } },
  });
}

export interface ValidateRoundtripOptions {
  readonly uiUrl: string;
  readonly internalSecret: string;
  readonly retries?: number;
  readonly backoffMs?: number;
  readonly perAttemptTimeoutMs?: number;
}

export interface ValidateRoundtripResult {
  readonly ok: boolean;
  readonly attempts: number;
  readonly status?: number;
  readonly body?: unknown;
  readonly error?: string;
}

/**
 * Round-trips a seed key through the same `/api/internal/validate-api-key`
 * route that `backend/rest/routers/public/traces.py` uses for OTLP ingest.
 *
 * Why this exists as a runtime guard (not a unit test): a previous run hit
 * a transient cold-start where rest's first call to web's validate route
 * timed out mid-OTLP, surfacing only as `0/N traces, timed out` 60 seconds
 * later — indistinguishable from a true rejection. This guard fails fast
 * with a precise diagnostic instead. Retries cover the cold-start window.
 *
 * Returns a result object instead of throwing so the caller can decide
 * whether to abort the run or warn-and-continue (e.g. when running against
 * a stack without web available).
 */
export async function validateSeedKeyRoundtrip(
  seeded: SeededProject,
  opts: ValidateRoundtripOptions,
): Promise<ValidateRoundtripResult> {
  const keyHash = sha256Hex(seeded.apiKey);
  const url = `${opts.uiUrl.replace(/\/$/, "")}/api/internal/validate-api-key`;
  const retries = opts.retries ?? 3;
  const backoffMs = opts.backoffMs ?? 500;
  const perAttemptTimeoutMs = opts.perAttemptTimeoutMs ?? 5000;

  let lastError: string | undefined;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Secret": opts.internalSecret,
        },
        body: JSON.stringify({ keyHash }),
        signal: AbortSignal.timeout(perAttemptTimeoutMs),
      });
      const status = response.status;
      const body: unknown = await response.json().catch(() => null);

      const isValid =
        typeof body === "object" &&
        body !== null &&
        (body as { valid?: unknown }).valid === true &&
        (body as { projectId?: unknown }).projectId === seeded.id;

      if (status === 200 && isValid) {
        return { ok: true, attempts: attempt, status, body };
      }

      // Got a definitive response but it didn't validate — no point retrying.
      return {
        ok: false,
        attempts: attempt,
        status,
        body,
        error: `validate-api-key returned status=${status}, body=${JSON.stringify(body)}`,
      };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, backoffMs * attempt));
      }
    }
  }
  return {
    ok: false,
    attempts: retries,
    error: `network error after ${retries} attempts: ${lastError ?? "unknown"}`,
  };
}

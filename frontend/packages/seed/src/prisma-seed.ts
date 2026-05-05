import { PrismaClient } from "@prisma/client";

import { deterministicHex, deterministicSeedApiKey, keyHint, sha256Hex } from "./crypto-utils.js";
import type { SeedProject, SeedWorkspace } from "./fixture-types.js";

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
      update: { name: ws.name },
      create: {
        id,
        name: ws.name,
        billingPlan: "free",
        ingestionBlocked: false,
        aiBlocked: false,
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

/** Removes all seed-prefixed Prisma rows. Cascades through Project → AccessKey. */
export async function resetPrisma(): Promise<void> {
  // Delete by id prefix; cascade does Project, AccessKey, WorkspaceMember.
  await getPrisma().workspace.deleteMany({
    where: { id: { startsWith: "seed-ws-" } },
  });
  await getPrisma().user.deleteMany({
    where: { id: { startsWith: "seed-user-" } },
  });
}

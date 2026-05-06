-- Adds is_seed flags to scope-detect synthetic seed data without relying on
-- id-prefix conventions alone. Used by `@traceroot/seed`'s discovery pass to
-- find detectors in seed-owned workspaces (and by reset to scope deletes).
-- Denormalized onto detectors so a UI-created detector inside a seed workspace
-- inherits the flag at insert time and survives workspace flag changes.

ALTER TABLE "workspaces" ADD COLUMN "is_seed" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "detectors" ADD COLUMN "is_seed" BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX "ix_workspace_is_seed" ON "workspaces"("is_seed") WHERE "is_seed" = TRUE;
CREATE INDEX "ix_detector_is_seed" ON "detectors"("is_seed") WHERE "is_seed" = TRUE;

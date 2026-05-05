/**
 * Day-anchored timestamps so re-running `make seed` on the same calendar day
 * produces byte-identical span timestamps. Combined with stable seed-prefixed
 * IDs, this lets ClickHouse `ReplacingMergeTree(ch_update_time)` natively
 * collapse duplicates on the next merge.
 *
 * Cross-day the anchor moves forward; old seed rows become orphans, so the
 * day-rollover probe in prisma-seed triggers `--reset` before re-seeding.
 *
 * Determinism beats freshness for seed data — visual-diff tests rely on it.
 */

const NOON_OFFSET_MS = 12 * 60 * 60 * 1000;

export function getSeedAnchor(now: Date = new Date()): Date {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  const startOfDay = Date.UTC(y, m, d, 0, 0, 0, 0);
  return new Date(startOfDay + NOON_OFFSET_MS);
}

export function getSeedAnchorDayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function offsetFromAnchor(anchor: Date, offsetMs: number): Date {
  return new Date(anchor.getTime() + offsetMs);
}

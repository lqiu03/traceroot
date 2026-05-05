import { createHash } from "node:crypto";

/**
 * SHA-256 hex digest. Must match the backend's
 * `hashlib.sha256(api_key.encode()).hexdigest()` in
 * `backend/rest/routers/public/traces.py:70` and the Prisma row written by
 * `frontend/ui/src/app/api/internal/validate-api-key/route.ts:36-38`
 * (which looks up `accessKey.secretHash` by this exact hash).
 */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Deterministic SHA-256-derived hex string of the given length (max 64). */
export function deterministicHex(seed: string, length: number): string {
  if (length <= 0 || length > 64) {
    throw new Error(`deterministicHex length must be in [1, 64], got ${length}`);
  }
  return sha256Hex(seed).slice(0, length);
}

/** UI-style key hint: first 4 + ellipsis + last 4 of the plaintext key. */
export function keyHint(plaintext: string): string {
  if (plaintext.length <= 8) return plaintext;
  return `${plaintext.slice(0, 4)}…${plaintext.slice(-4)}`;
}

/**
 * Plaintext seed API key for a project. Deterministic from the project slug
 * so the same seed produces the same key — `make seed` is idempotent.
 *
 * Hex slice ensures URL-safe characters and a stable length.
 */
export function deterministicSeedApiKey(projectSlug: string): string {
  return `tr_seed_${deterministicHex(`api-key:${projectSlug}`, 48)}`;
}

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { deterministicHex, deterministicSeedApiKey, keyHint, sha256Hex } from "../crypto-utils.js";

describe("sha256Hex", () => {
  it("matches Node's built-in SHA-256 (parity with backend Python contract)", () => {
    const input = "tr_seed_abc123";
    const expected = createHash("sha256").update(input).digest("hex");
    expect(sha256Hex(input)).toBe(expected);
    expect(expected).toHaveLength(64);
  });
});

describe("deterministicHex", () => {
  it("produces stable output for the same seed", () => {
    expect(deterministicHex("seed-x", 16)).toBe(deterministicHex("seed-x", 16));
  });

  it("respects the requested length", () => {
    expect(deterministicHex("seed-x", 1)).toHaveLength(1);
    expect(deterministicHex("seed-x", 64)).toHaveLength(64);
  });

  it("rejects out-of-range length", () => {
    expect(() => deterministicHex("seed-x", 0)).toThrow();
    expect(() => deterministicHex("seed-x", 65)).toThrow();
  });
});

describe("deterministicSeedApiKey", () => {
  it("is stable across calls", () => {
    expect(deterministicSeedApiKey("checkout")).toBe(deterministicSeedApiKey("checkout"));
  });

  it("differs by project slug", () => {
    expect(deterministicSeedApiKey("checkout")).not.toBe(deterministicSeedApiKey("search"));
  });

  it("uses the tr_seed_ prefix", () => {
    expect(deterministicSeedApiKey("checkout").startsWith("tr_seed_")).toBe(true);
  });
});

describe("keyHint", () => {
  it("returns the key unchanged when too short", () => {
    expect(keyHint("abcd")).toBe("abcd");
  });

  it("masks the middle for long keys", () => {
    const key = "tr_seed_0123456789abcdef0123456789abcdef";
    const hint = keyHint(key);
    expect(hint.startsWith(key.slice(0, 4))).toBe(true);
    expect(hint.endsWith(key.slice(-4))).toBe(true);
    expect(hint.length).toBeLessThan(key.length);
  });
});

import { describe, expect, it } from "vitest";

import { parseRedisUrl } from "../clickhouse-helpers.js";

describe("parseRedisUrl", () => {
  it("parses a default localhost url", () => {
    const p = parseRedisUrl("redis://localhost:6379/0");
    expect(p).toEqual({ host: "127.0.0.1", port: 6379, db: 0, password: undefined });
  });

  it("normalizes 'localhost' → 127.0.0.1 to match Docker port-binding", () => {
    expect(parseRedisUrl("redis://localhost:6379/0").host).toBe("127.0.0.1");
  });

  it("defaults port to 6379 when omitted", () => {
    expect(parseRedisUrl("redis://example.com/0").port).toBe(6379);
  });

  it("defaults db to 0 when path is empty", () => {
    expect(parseRedisUrl("redis://localhost").db).toBe(0);
  });

  it("parses non-zero db numbers", () => {
    expect(parseRedisUrl("redis://localhost:6379/3").db).toBe(3);
  });

  it("extracts password when present", () => {
    expect(parseRedisUrl("redis://:secret@localhost:6379/0").password).toBe("secret");
  });

  it("rejects non-redis protocols", () => {
    expect(() => parseRedisUrl("http://localhost:6379")).toThrow();
    expect(() => parseRedisUrl("memcached://localhost:11211")).toThrow();
  });

  it("accepts rediss:// (TLS)", () => {
    expect(() => parseRedisUrl("rediss://localhost:6379/0")).not.toThrow();
  });
});

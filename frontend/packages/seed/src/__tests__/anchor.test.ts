import { describe, expect, it } from "vitest";

import { getSeedAnchor, getSeedAnchorDayKey, offsetFromAnchor } from "../anchor.js";

describe("getSeedAnchor", () => {
  it("returns UTC noon of the given calendar day", () => {
    const now = new Date("2026-05-05T03:14:15.123Z");
    const anchor = getSeedAnchor(now);
    expect(anchor.toISOString()).toBe("2026-05-05T12:00:00.000Z");
  });

  it("is byte-identical for any two timestamps within the same UTC day", () => {
    const morning = new Date("2026-05-05T00:00:00Z");
    const evening = new Date("2026-05-05T23:59:59Z");
    expect(getSeedAnchor(morning).getTime()).toBe(getSeedAnchor(evening).getTime());
  });

  it("differs across UTC day boundaries", () => {
    const day1 = new Date("2026-05-05T23:59:59Z");
    const day2 = new Date("2026-05-06T00:00:00Z");
    expect(getSeedAnchor(day1).getTime()).not.toBe(getSeedAnchor(day2).getTime());
  });
});

describe("getSeedAnchorDayKey", () => {
  it("returns YYYY-MM-DD in UTC", () => {
    expect(getSeedAnchorDayKey(new Date("2026-05-05T03:14:15Z"))).toBe("2026-05-05");
    expect(getSeedAnchorDayKey(new Date("2026-12-31T23:59:59Z"))).toBe("2026-12-31");
  });
});

describe("offsetFromAnchor", () => {
  it("adds milliseconds without mutation", () => {
    const anchor = new Date("2026-05-05T12:00:00Z");
    const out = offsetFromAnchor(anchor, 1234);
    expect(out.toISOString()).toBe("2026-05-05T12:00:01.234Z");
    expect(anchor.toISOString()).toBe("2026-05-05T12:00:00.000Z");
  });
});
